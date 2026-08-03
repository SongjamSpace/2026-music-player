const { app, BrowserWindow, Menu, crashReporter, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
// Async FS for anything that touches the download root: it lives on an external
// drive, and a sync call against a spun-down disk blocks the wire protocol.
// The crash-diagnostics paths stay sync on purpose — see writeSessionFlag.
const fsp = require('fs/promises');
const net = require('net');
const crypto = require('crypto');
const dgram = require('dgram');
const path = require('path');
const Store = require('electron-store');
const mm = require('music-metadata');
const {
  TorrentService,
  DEFAULT_DOWNLOAD_PATH,
  infoHashFromMagnet,
  AUDIO_RE,
} = require('./torrent-service');
const { createTrackers } = require('./trackers');
const { createPiecePolicy } = require('./piece-policy');
const nat = require('./nat');
const netPath = require('./net-path');
const swarmProbe = require('./swarm-probe');

// Pin the data directory before anything reads it.
//
// Electron derives userData from the app name, which changes the moment a
// packaged build sets a productName — silently orphaning the library, prefs and
// cached .torrent files created while running from source. Naming it explicitly
// keeps `npm start` and the built .app pointing at the same folder.
app.setPath('userData', path.join(app.getPath('appData'), '2026-music-player'));

// -- crash safety net --------------------------------------------------------
//
// An uncaught throw in the main process takes the whole app down instantly:
// no macOS crash report (nothing crashed natively), no dialog, and stderr goes
// nowhere when launched from Finder. The result is an app that "just
// disappears" with no evidence at all, which is exactly what happened here.
//
// Two 1 Hz timers drive the torrent engine and both reach into WebTorrent
// internals; several of those — select/deselect/critical — throw outright on a
// torrent that was destroyed a moment earlier. Those call sites are guarded
// individually, but this is the backstop that makes a miss survivable and,
// more importantly, leaves a trace.

const CRASH_LOG = path.join(app.getPath('userData'), 'errors.log');

function recordError(kind, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  const line = '[' + new Date().toISOString() + '] ' + kind + '\n' + detail + '\n\n';
  console.error('[' + kind + ']', detail);
  try {
    fs.appendFileSync(CRASH_LOG, line);
  } catch (_) {
    /* logging must never be the thing that kills us */
  }
}

// Deliberately does NOT rethrow. A failed progress tick or a stale torrent
// handle is not a reason to drop playback and lose the user's session; it is a
// reason to write it down and carry on.
process.on('uncaughtException', (err) => recordError('uncaughtException', err));
process.on('unhandledRejection', (err) => recordError('unhandledRejection', err));

// -- native crash detection --------------------------------------------------
//
// The handlers above cannot see the failure that actually took this app down
// twice: a SIGSEGV inside utp-native, on the browser main thread. A segfault
// kills the process at the OS level — no JS runs, nothing is written, and from
// the user's side the app simply blinks out of existence.
//
// Two mechanisms are needed to have any evidence at all:
//
//  1. Crashpad writes a native minidump at the moment of the fault. It also
//     covers renderer and GPU process crashes, which don't reliably produce a
//     macOS .ips report the way a browser-process crash does.
//  2. A session sentinel, because a dump tells us *that* it died but nothing
//     about what the app was doing. The sentinel is rewritten periodically
//     with live state and deleted on clean quit, so finding one at startup
//     means the last session ended abnormally — and its contents are the last
//     known state before it did.
//
// Both are local-only. Nothing is uploaded anywhere.

crashReporter.start({ uploadToServer: false, compress: true });

const SESSION_FLAG = path.join(app.getPath('userData'), 'session.running');
const MAX_LOG_BYTES = 512 * 1024;
const STARTED_AT = new Date().toISOString();

// What the previous session was doing when it died, or null on a clean start.
// Read once at startup, before the flag is overwritten.
let lastAbnormalExit = null;

function readAbnormalExit() {
  let raw;
  try {
    raw = fs.readFileSync(SESSION_FLAG, 'utf8');
  } catch (_) {
    return null; // no flag — last quit was clean
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (_) {
    state = { note: 'sentinel unreadable' };
  }
  // Force Quit and a power cut leave the same trace as a segfault, so the
  // wording stays honest about what is actually known. A matching Crashpad
  // dump is what distinguishes them.
  state.dumps = latestDumps(state.started);
  state.diagnosis = state.dumps.length
    ? 'native crash — a minidump was written'
    : state.maxLagMs > 5000
      ? 'no crash dump, and the main thread was already blocking for up to ' +
        Math.round(state.maxLagMs / 1000) +
        's — most likely a freeze'
      : 'no crash dump — force quit, power loss, or a frozen event loop';
  recordError('previous session ended unexpectedly', new Error(JSON.stringify(state, null, 2)));
  return state;
}

/** Minidump filenames written since the given ISO timestamp. */
function latestDumps(sinceIso) {
  const dir = path.join(app.getPath('crashDumps'), 'completed');
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.dmp'))
      .filter((f) => fs.statSync(path.join(dir, f)).mtimeMs >= since)
      .slice(-3);
  } catch (_) {
    return [];
  }
}

const SESSION_TICK_MS = 30000;
// How late this timer runs is a direct measurement of main-thread blocking:
// nothing else can delay it. A freeze that never ends can't be recorded from
// inside the frozen process, but everything short of that shows up here — and
// a large value in the last record before an unexplained exit is the signature
// of an event loop that was already in trouble.
let lastTickAt = Date.now();
let maxLagMs = 0;

/**
 * Breadcrumbs for the next crash. Cheap enough to run on a timer, and the only
 * way a native fault leaves any application-level context behind.
 */
function writeSessionFlag() {
  const now = Date.now();
  const lag = now - lastTickAt - SESSION_TICK_MS;
  if (lag > maxLagMs) maxLagMs = lag;
  lastTickAt = now;

  let live = {};
  try {
    const d = torrentService.getDiagnostics();
    const client = torrentService.client;
    live = {
      utp: !!(d && d.client && d.client.utp),
      torrentPort: d && d.client ? d.client.torrentPort : null,
      downloadSpeed: d && d.client ? Math.round(d.client.downloadSpeed) : null,
      torrents: client ? client.torrents.length : 0,
      // Total wires is the number that matters for the utp-native fault: the
      // crash is socket churn, so a high count here next to a dump is the
      // signal.
      wires: client ? client.torrents.reduce((n, t) => n + ((t.wires && t.wires.length) || 0), 0) : 0,
      inboundNow: d ? d.inboundNow : null,
      inboundPeak: d ? d.inboundPeak : null,
      // Memory, because the failure this app actually exhibits is not a fault —
      // it is the main process growing until macOS starts compressing and
      // swapping its pages, at which point every IPC round trip can block on a
      // page-in and the app beachballs. A dump tells you nothing about that; a
      // heap trend across sessions does. rss understates a swapped process, so
      // heapUsed is recorded next to it as the V8-side number.
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  } catch (_) {
    /* diagnostics must never be able to break the thing recording the crash */
  }
  try {
    fs.writeFileSync(
      SESSION_FLAG,
      JSON.stringify(
        Object.assign(
          {
            pid: process.pid,
            started: STARTED_AT,
            updated: new Date().toISOString(),
            maxLagMs: Math.max(0, Math.round(maxLagMs)),
          },
          live
        )
      )
    );
  } catch (_) {
    /* ignore */
  }
}

function clearSessionFlag() {
  try {
    fs.unlinkSync(SESSION_FLAG);
  } catch (_) {
    /* already gone */
  }
}

/** Keeps errors.log from growing without bound; halves it when it gets big. */
function rotateCrashLog() {
  try {
    if (fs.statSync(CRASH_LOG).size <= MAX_LOG_BYTES) return;
    const text = fs.readFileSync(CRASH_LOG, 'utf8');
    fs.writeFileSync(CRASH_LOG, text.slice(-Math.floor(MAX_LOG_BYTES / 2)));
  } catch (_) {
    /* no log yet, or unwritable */
  }
}

const store = new Store();
const torrentService = new TorrentService();
const piecePolicy = createPiecePolicy({
  service: torrentService,
  getPrefs: () => getPrefs(),
});

const DEFAULT_PREFS = {
  theme: 'midnight',
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  lastTorrentId: null,
  prefetch: true,
  readDurations: false,
  durations: {},
  dsp: {},
  // Null until first launch picks one — see resolveTorrentPort().
  torrentPort: null,
  uploadLimit: 1500000,
  // 'auto' follows the play-head buffer; the other two pin it for A/B testing.
  pieceStrategy: 'auto',
  showNetPanel: false,

  // An expectation the app checks reality against — NOT a control. The app
  // cannot choose an interface; see the routing note at the top of net-path.js.
  // null means "adopt whatever is detected", resolved once on first launch.
  expectedPath: null, // 'auto' | 'direct' | 'vpn' | 'vpn-preferred'
  homeNetwork: null, // fingerprint from netPath.fingerprint()
  peerEncryption: true, // restart-required in both directions
  // Opt-in, because utp-native segfaults under load — see the note at the
  // client options in torrent-service.js. Restart-required.
  enableUtp: false,
};

let mainWindow = null;
// Set when the preferred listen port was taken and we fell back to ephemeral,
// so the UI can explain why incoming connections are off.
let portFallback = null;

function getPrefs() {
  return Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
}

function setPref(key, value) {
  const prefs = getPrefs();
  prefs[key] = value;
  store.set('prefs', prefs);
  return prefs;
}

/**
 * A fixed listen port, chosen once per install and then kept.
 *
 * Not ephemeral: a random port can't be port-forwarded, and every peer that
 * learned our address through DHT or PEX is unable to reconnect after a
 * restart. Not 51413 either — that's Transmission's well-known port and the
 * first thing a traffic shaper looks for. Random-per-install in the dynamic
 * range gives a stable address without a recognisable fingerprint.
 */
function preferredTorrentPort() {
  const saved = getPrefs().torrentPort;
  if (Number.isInteger(saved) && saved > 1024 && saved < 65534) return saved;
  const port = 49160 + Math.floor(Math.random() * 15000);
  setPref('torrentPort', port);
  return port;
}

function canBindTcp(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function canBindUdp(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      try {
        socket.close();
      } catch (_) {
        /* already gone */
      }
      resolve(false);
    });
    socket.bind(port, () => socket.close(() => resolve(true)));
  });
}

/**
 * Check the port is actually free before handing it to WebTorrent.
 *
 * This matters more than it looks: WebTorrent treats a failed listen as a fatal
 * client error and destroys itself, so a single EADDRINUSE takes down every
 * torrent with a "client is destroyed" for anything you try afterwards. A
 * second copy of the app — or anything else on that port — would otherwise
 * leave the player silently unable to download at all.
 *
 * Falling back to an ephemeral port loses inbound connectivity for the session,
 * which is a real cost, but it is not remotely the same cost as no downloads.
 */
async function resolveTorrentPort() {
  const preferred = preferredTorrentPort();
  const free =
    (await canBindTcp(preferred)) &&
    (await canBindUdp(preferred)) &&
    (await canBindUdp(preferred + 1));
  if (free) return { port: preferred, preferred, fellBack: false };

  console.warn(
    '[torrent] port ' + preferred + ' is in use (another copy of the app?) — ' +
    'falling back to a random port for this session; incoming connections will not work'
  );
  return { port: 0, preferred, fellBack: true };
}

/**
 * Force permissive CORS on the per-torrent stream servers.
 *
 * Web Audio silently outputs nothing for a CORS-tainted media element, so the
 * equaliser needs the elements loaded with `crossorigin="anonymous"`. WebTorrent's
 * server does send an ACAO header, but only echoes the request's own origin — and
 * this renderer is a file:// page, so that origin is the string "null". Rather than
 * depend on Chromium accepting a literal `null` match, pin it to `*`, which is
 * always valid for an uncredentialed request.
 *
 * Filtering happens in JS rather than via a urls match pattern because Chrome
 * patterns can't express "any port", and every torrent server gets a random one.
 */
function installStreamCorsHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.indexOf('http://127.0.0.1:') !== 0) return callback({});

    const headers = Object.assign({}, details.responseHeaders);
    // Strip any existing variant first: two conflicting ACAO headers fail outright.
    Object.keys(headers).forEach((key) => {
      if (/^access-control-allow-(origin|methods|headers)$/i.test(key)) delete headers[key];
    });
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['Range'];
    headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges'];
    callback({ responseHeaders: headers });
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0d0d0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Passed synchronously so the renderer can set the theme before first paint.
      // An inline bootstrap script is impossible under `script-src 'self'`, and
      // reading the theme over async IPC would guarantee a flash.
      additionalArguments: ['--mp-theme=' + getPrefs().theme],
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (!app.isPackaged && process.env.MP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Mirror renderer console output into the terminal. Off by default; the
  // renderer is otherwise a black box unless DevTools happens to be open.
  if (!app.isPackaged && process.env.MP_DEBUG === '1') {
    const levels = ['debug', 'info', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      const where = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
      console.log(`[renderer:${levels[level] || level}] ${message}${where}`);
    });
  }

  // Always on, packaged included. A dead renderer is a blank window with the
  // audio cut off and no clue why — indistinguishable from "the app crashed".
  // Reloading gets playback controls back; the reason lands in the log either
  // way. `clean-exit` is the normal teardown on quit, so it isn't a failure.
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer] gone:', details.reason, 'exitCode:', details.exitCode);
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return;
    mainWindow.reload();
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[renderer] unresponsive — main thread blocked');
  });
  mainWindow.webContents.on('responsive', () => {
    console.error('[renderer] responsive again');
  });
}

function buildMenu() {
  const cmd = (command) => () => send('menu-command', command);
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add Magnet…', accelerator: 'CmdOrCtrl+N', click: cmd('add-magnet') },
        { type: 'separator' },
        { label: 'Reveal Downloads in Finder', click: cmd('reveal-downloads') },
        { label: 'Reveal Torrent in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('reveal-torrent') },
        // No accelerator: Cmd+Delete is "delete to line start" inside the
        // magnet field, and a menu accelerator would swallow it there.
        { label: 'Remove Selected Torrent', click: cmd('remove-torrent') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Playback',
      // Space and the Cmd+Arrow pairs are handled in the renderer instead of as
      // accelerators here: a menu accelerator fires even while a text field has
      // focus, which would make Space and Cmd+Left unusable in the magnet field.
      submenu: [
        { label: 'Play / Pause', click: cmd('play-pause') },
        { label: 'Next Track', click: cmd('next') },
        { label: 'Previous Track', click: cmd('prev') },
        { type: 'separator' },
        { label: 'Audio Effects…', accelerator: 'CmdOrCtrl+E', click: cmd('dsp') },
        { type: 'separator' },
        { label: 'Mute', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('mute') },
        { label: 'Shuffle', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('shuffle') },
        { label: 'Cycle Repeat', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('repeat') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Cycle Theme', accelerator: 'CmdOrCtrl+Alt+T', click: cmd('cycle-theme') },
        { label: 'Find in Tracks', accelerator: 'CmdOrCtrl+F', click: cmd('focus-filter') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: cmd('shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * First-run resolution of `expectedPath`, plus the initial probe.
 *
 * The expectation is adopted from what is actually detected, and it is done
 * here in main rather than in the renderer so that a launch on a broken network
 * can't bake in a wrong expectation from a stale UI read. Written through
 * setPref so it survives, and only ever set once.
 */
async function initNetPath() {
  if (getPrefs().expectedPath == null) {
    const egress = await netPath.detectEgress();
    const adopted = egress && egress.tunnel ? 'vpn-preferred' : 'direct';
    setPref('expectedPath', adopted);
    netPath.setExpected(adopted);
    console.log('[net-path] first run — expecting ' + adopted);
  }
  await netPath.refreshFingerprint();
  await netPath.preflight();
}

// userData is already pinned at the top of this file, so it is safe to read
// before 'ready'.
const trackers = createTrackers({
  cacheDir: app.getPath('userData'),
  log: (msg) => console.log(msg),
});

app.whenReady().then(async () => {
  rotateCrashLog();
  // Must read before the new flag is written, or this session overwrites the
  // evidence from the one that died.
  lastAbnormalExit = readAbnormalExit();
  writeSessionFlag();
  setInterval(writeSessionFlag, SESSION_TICK_MS).unref();

  installStreamCorsHeaders();
  torrentService.setCacheDir(path.join(app.getPath('userData'), 'torrents'));

  const listen = await resolveTorrentPort();
  portFallback = listen.fellBack ? listen.preferred : null;
  await torrentService.start({
    torrentPort: listen.port,
    uploadLimit: getPrefs().uploadLimit,
    secure: getPrefs().peerEncryption !== false,
    utp: getPrefs().enableUtp === true,
    trackers,
  });

  // A destroyed client is unrecoverable in place, so say so plainly rather than
  // letting the user watch 0 B/s and conclude the swarms are dead.
  torrentService.onClientError = (info) => {
    recordError('torrent client error', new Error(info.message));
    send('torrent-error', {
      message: info.fatal
        ? 'The torrent engine stopped (' + info.message + '). Restart the app to resume downloads.'
        : 'Torrent engine warning: ' + info.message,
    });
  };

  netPath.setExpected(getPrefs().expectedPath);
  netPath.setHome(getPrefs().homeNetwork);
  // Fire and forget, same reasoning as nat.open(): nothing about showing a
  // window should wait on a network probe.
  initNetPath().catch((err) => console.error('[net-path] startup:', err.message));

  // Fire and forget: torrents added before this lands still get the cached or
  // builtin list, and the refreshed one persists for next launch.
  trackers.refresh();

  // Also fire and forget. A silent gateway takes seconds to time out, and there
  // is nothing about opening a window that should wait on the router.
  // Pointless on an ephemeral port: it changes every launch, so the mapping
  // would be stale before anyone could use it. nat.open() additionally skips
  // the router entirely when traffic egresses a tunnel.
  if (listen.port) {
    nat
      .open({ torrentPort: listen.port, dhtPort: listen.port + 1 })
      .then((s) => send('nat-status', s))
      .catch((err) => console.error('[nat] unexpected:', err.message));
  }

  piecePolicy.start();

  const savedPath = store.get('downloadPath');
  const library = checkLibraryRoot(savedPath);
  if (savedPath && library.ok) {
    torrentService.setDownloadPath(savedPath);
  }

  buildMenu();
  createWindow();

  const savedMagnets = store.get('magnets', []);
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      // The library warning goes first: if the drive is missing, the renderer must
      // know before it starts rendering torrents that will all read as 0%.
      if (!library.ok) send('library-unavailable', library);
      else if (savedMagnets.length > 0) send('restore-magnets', savedMagnets);
    });
  }
});

// -- shutdown --------------------------------------------------------------
//
// Releasing the router mappings is asynchronous, so teardown can't happen
// inline in 'window-all-closed' the way it used to. Leaked mappings aren't
// catastrophic — they expire with their TTL — but they accumulate in the
// router's table across restarts, and small routers do run out.

const SHUTDOWN_TIMEOUT_MS = 3000;
let shuttingDown = false;

async function shutdown() {
  piecePolicy.stop();
  // A router that stops answering mid-unmap must never be able to wedge quit.
  await Promise.race([
    nat.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  try {
    torrentService.destroy();
  } catch (err) {
    console.warn('[shutdown] torrent teardown:', err.stack || err.message);
  }
  // Last thing, and only on the path that ran teardown: the absence of this
  // file is the entire signal that the previous session exited cleanly.
  clearSessionFlag();
}

app.on('before-quit', (event) => {
  if (shuttingDown) return; // second pass — let Electron finish the quit
  shuttingDown = true;
  event.preventDefault();
  console.log('[shutdown] releasing port mappings…');
  // Never leave this un-caught: if teardown rejects, the app hangs with no
  // window and no way to quit but Force Quit.
  shutdown()
    .catch((err) => console.warn('[shutdown] failed:', err.message))
    .then(() => {
      console.log('[shutdown] done');
      app.quit();
    });
});

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('add-torrent', async (event, magnetUri) => {
  // webtorrent.add() on an already-present infoHash emits an error. `restore-magnets`
  // re-sends every saved magnet on launch, so without this guard a relaunch errors
  // once per saved torrent.
  const hash = infoHashFromMagnet(magnetUri);
  if (hash && torrentService.has(hash)) {
    return { success: true, pending: false, duplicate: true, id: hash };
  }

  const onTorrentReady = (data) => {
    send('torrent-ready', data);
    const magnets = store.get('magnets', []);
    if (!magnets.includes(magnetUri)) {
      magnets.push(magnetUri);
      store.set('magnets', magnets);
    }
  };
  const onProgress = (data) => send('torrent-progress', data);
  const onError = (err) => send('torrent-error', { message: err.message || String(err) });

  await torrentService.add(magnetUri, onTorrentReady, onProgress, onError);
  return { success: true, pending: true, id: hash };
});

ipcMain.handle('get-torrents', () => torrentService.getTorrents());

// -- embedded artwork ------------------------------------------------------
//
// Plenty of releases ship no cover.jpg at all and carry the art in the audio
// tags instead — that's what Finder and Music.app are reading.
//
// The reply is an explicit status rather than a nullable value, because the two
// "no art right now" cases are not the same and conflating them was a real bug:
// this handler returned `null` both for "nothing has finished downloading yet,
// ask again" and for "parsed a complete file and there is genuinely no art,
// stop asking", while the renderer treated `null` as terminal. Art therefore
// never appeared for any torrent that was still incomplete the first time a tile
// asked for it — which is every torrent, since tiles render immediately.
//
//   pending  nothing complete to read yet; ask again later
//   none     parsed and there is no embedded art; terminal
//   ok       `url` is a data URL of the picture
const ART_STATUS = { pending: 'pending', none: 'none', ok: 'ok' };

/**
 * Bounded because it holds base64 image data — roughly 1.37x the JPEG per entry,
 * and a 3 MB cover is not unusual. It previously grew for the life of the process
 * and was not even cleared when a torrent was removed. Phase 6 replaces the data
 * URLs with resized files on disk served by URL; until then, cap the count.
 */
const ART_CACHE_MAX = 32;
const albumArtCache = new Map();

function cacheArt(torrentId, value) {
  // Insertion-ordered, so the oldest key is the first — a good-enough LRU for a
  // cache this small, and cheaper than tracking access times.
  if (albumArtCache.size >= ART_CACHE_MAX && !albumArtCache.has(torrentId)) {
    albumArtCache.delete(albumArtCache.keys().next().value);
  }
  albumArtCache.set(torrentId, value);
  return value;
}

ipcMain.handle('get-album-art', async (event, torrentId) => {
  if (albumArtCache.has(torrentId)) return albumArtCache.get(torrentId);

  const candidates = torrentService.getCompleteAudioPaths(torrentId, 3);
  // Deliberately not cached: this is the retryable case.
  if (!candidates.length) return { status: ART_STATUS.pending };

  for (const file of candidates) {
    try {
      const meta = await mm.parseFile(file, { duration: false, skipPostHeaders: true });
      const picture = (meta.common.picture || [])[0];
      if (picture && picture.data && picture.data.length) {
        const url =
          'data:' + (picture.format || 'image/jpeg') + ';base64,' +
          Buffer.from(picture.data).toString('base64');
        return cacheArt(torrentId, {
          status: ART_STATUS.ok,
          url,
          artist: meta.common.artist || null,
          album: meta.common.album || null,
        });
      }
    } catch (err) {
      console.warn('[art] could not read tags from', path.basename(file), '-', err.message);
    }
  }

  return cacheArt(torrentId, { status: ART_STATUS.none });
});

// -- library root safety ---------------------------------------------------
//
// The library lives on an external drive, and losing sight of it is the most
// destructive thing that can happen to this app — far worse than a crash.
//
// `/Volumes/My Book/...` is an ordinary path when the drive is not mounted:
// macOS will happily let a stub directory be created there. WebTorrent then sees
// every torrent at 0%, and starts re-downloading the entire library over the
// swarm — 11.4 GB, on a metered connection, silently overwriting nothing but
// wasting everything. Checking `existsSync` alone does not catch it, because
// after the first bad launch the stub directory *does* exist.
//
// So the root has to identify itself. A marker file holding a random id, written
// once and compared on every launch, distinguishes "my library" from "some empty
// directory that happens to sit at the same path". It also survives the drive
// being renamed or remounted at a different mount point, which a volume UUID
// from `diskutil` would not, and it needs no subprocess.

const LIBRARY_MARKER = '.mp-library-id';

/**
 * @param {string} root
 * @param {boolean=} adopt  True when the user has just picked this folder in a
 *   dialog. That is an explicit act, so an empty directory is a legitimate
 *   choice — someone moving the library to a fresh drive — rather than the
 *   unmounted-volume signature it would be at launch.
 * @returns {{ok: boolean, reason?: string, path?: string}}
 *   `ok: false` means: add nothing, seed nothing, and tell the user. Never
 *   create the directory — creating it is the bug.
 */
function checkLibraryRoot(root, adopt) {
  if (!root) return { ok: true }; // never configured; the default path applies
  const markerPath = path.join(root, LIBRARY_MARKER);
  const expected = store.get('libraryId') || null;

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    return { ok: false, reason: 'missing', path: root };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'missing', path: root };

  let marker = null;
  try {
    marker = fs.readFileSync(markerPath, 'utf8').trim() || null;
  } catch (_) {
    /* no marker yet */
  }

  // First run against a root we have never stamped. Adopt it rather than
  // refusing — but only if it is genuinely ours: an empty directory at this path
  // with torrents already in the library is exactly the unmounted-drive case.
  if (!expected) {
    if (!marker) {
      const hasLibrary = (store.get('magnets', []) || []).length > 0;
      let looksPopulated = false;
      try {
        looksPopulated = fs.readdirSync(root).some((n) => !n.startsWith('.'));
      } catch (_) {
        /* unreadable — treat as empty */
      }
      // An unstamped, empty root while the library is non-empty is the
      // unmounted-drive signature. Unless the user just chose it by hand.
      if (!adopt && hasLibrary && !looksPopulated) {
        return { ok: false, reason: 'empty', path: root };
      }
      marker = crypto.randomUUID();
      try {
        fs.writeFileSync(markerPath, marker);
      } catch (err) {
        // A read-only or absent volume. Do not proceed on a guess.
        return { ok: false, reason: 'unwritable', path: root, detail: err.message };
      }
    }
    store.set('libraryId', marker);
    return { ok: true };
  }

  // Stamped in prefs but the marker is not there. Could be our drive with the
  // dotfile deleted, or could be a stub at the same path — and we cannot tell.
  // Refusing is recoverable (re-pick the folder in Settings); proceeding risks
  // re-downloading the entire library, so this errs toward refusing.
  if (!marker) return { ok: false, reason: 'unstamped', path: root };
  if (marker !== expected) return { ok: false, reason: 'mismatch', path: root };
  return { ok: true };
}

// -- local-folder fallback -------------------------------------------------

/**
 * Directory listing of the download root, cached for a few seconds.
 *
 * The library lives on an external drive, and `readdirSync` against a spun-down
 * USB disk blocks for seconds — on the same thread as the wire protocol, the
 * piece picker and every IPC reply. So: async, and not re-read once per torrent
 * when the user clicks through several unresolved albums in a row.
 *
 * The TTL is short because the point of this scan is to notice files the user
 * put there by hand.
 */
const ROOT_LISTING_TTL_MS = 5000;
let rootListing = { root: null, at: 0, dirs: null };

async function listDownloadRoot() {
  const root = torrentService.getDownloadPath();
  const now = Date.now();
  if (rootListing.root === root && rootListing.dirs && now - rootListing.at < ROOT_LISTING_TTL_MS) {
    return rootListing.dirs;
  }
  let dirs = [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    /* root missing or unreadable — treat as empty, never as an error */
  }
  rootListing = { root, at: now, dirs };
  return dirs;
}

/** Locate the download folder for a torrent we have no metadata for. */
async function findLocalFolder(torrentId) {
  const magnet = store.get('magnets', []).find((m) => infoHashFromMagnet(m) === torrentId);
  if (!magnet) return null;
  const dn = /[?&]dn=([^&]+)/.exec(magnet);
  if (!dn) return null;

  let name;
  try {
    name = decodeURIComponent(dn[1].replace(/\+/g, ' '));
  } catch (_) {
    return null;
  }

  const root = torrentService.getDownloadPath();
  try {
    const st = await fsp.stat(path.join(root, name));
    if (st.isDirectory()) return path.join(root, name);
  } catch (_) {
    /* no exact match — fall through to the loose one */
  }

  // The folder on disk comes from the .torrent's name, which can differ from
  // the magnet's display name, so fall back to a loose match.
  const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalise(name);
  const hit = (await listDownloadRoot()).find((dirName) => {
    const n = normalise(dirName);
    return n === target || n.startsWith(target.slice(0, 24)) || target.startsWith(n.slice(0, 24));
  });
  return hit ? path.join(root, hit) : null;
}

/**
 * How many real audio tracks are in a folder.
 *
 * `._name.mp3` files are excluded deliberately. The library sits on exFAT, which
 * has no native extended attributes, so macOS writes every xattr into an
 * AppleDouble sidecar next to the real file — same extension, a few hundred
 * bytes. Counting those doubled the reported track count on that drive, and a
 * folder of nothing but sidecars would have read as "already downloaded".
 */
async function countMedia(folder) {
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith('._')) continue;
      if (AUDIO_RE.test(e.name)) n++;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

ipcMain.handle('check-local-folder', async (event, torrentId) => {
  if (torrentService.hasMetadata(torrentId)) return { available: false };
  const folder = await findLocalFolder(torrentId);
  if (!folder) return { available: false };
  const trackCount = await countMedia(folder);
  return trackCount > 0
    ? { available: true, path: folder, name: path.basename(folder), trackCount }
    : { available: false };
});

ipcMain.handle('load-from-disk', async (event, torrentId) => {
  const folder = await findLocalFolder(torrentId);
  if (!folder) return { error: 'No matching folder in your downloads' };
  try {
    const onProgress = (data) => send('torrent-progress', data);
    const result = await torrentService.seedFromDisk(
      torrentId,
      folder,
      (data) => send('torrent-ready', data),
      onProgress,
      (err) => send('torrent-error', { message: err.message || String(err) })
    );
    return { success: true, fileCount: result.fileCount };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('remove-torrent', async (event, torrentId, destroyStore) => {
  // Capture the real infohash before removal drops the alias, or piecePolicy's
  // per-torrent memos have nothing to key off.
  const realHash = torrentService.realInfoHash(torrentId);
  await torrentService.remove(torrentId, destroyStore);
  const hash = String(torrentId).toLowerCase();
  const magnets = store.get('magnets', []);
  // Match on the parsed infohash, not a substring of the whole URI — a `dn=` display
  // name could otherwise contain the hash and take an unrelated magnet with it.
  store.set('magnets', magnets.filter((m) => infoHashFromMagnet(m) !== hash));

  // Everything else in this process keyed by torrent id. None of this was being
  // released: removing an album left its artwork, its debounce timers and its
  // piece-policy memos behind for the life of the session.
  albumArtCache.delete(torrentId);
  clearTimeout(priorityTimers.get(torrentId));
  priorityTimers.delete(torrentId);
  priorityLast.delete(torrentId);
  piecePolicy.forget(realHash || hash);
});

ipcMain.handle('get-download-path', () => torrentService.getDownloadPath());

ipcMain.handle('set-download-path', (event, dir) => {
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
  // Choosing a folder is an explicit act, so re-stamp: this root is now the
  // library, whatever the old marker said. Without this, switching drives would
  // trip the mismatch guard on the next launch.
  store.delete('libraryId');
  const library = checkLibraryRoot(dir, true);
  if (!library.ok) send('library-unavailable', library);
  return torrentService.getDownloadPath();
});

ipcMain.handle('get-default-download-path', () => DEFAULT_DOWNLOAD_PATH);

ipcMain.handle('choose-download-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose download folder',
    defaultPath: torrentService.getDownloadPath(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use Folder',
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
  return { canceled: false, path: dir };
});

ipcMain.handle('get-prefs', () => getPrefs());

ipcMain.handle('set-pref', (event, key, value) => {
  const prefs = setPref(key, value);
  // The upload cap is a live knob — webtorrent rebuilds the throttle group on
  // the fly, so there's no reason to make the user restart for it. The listen
  // port is not: changing it means rebinding sockets and remapping the router.
  if (key === 'uploadLimit') torrentService.setUploadLimit(value);
  // Pure display state — the app cannot act on an expectation, only check it.
  if (key === 'expectedPath') netPath.setExpected(value);
  // peerEncryption is deliberately absent: enableSecure() is one-way, so it
  // cannot be applied live in either direction. The Settings row says so.
  return prefs;
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Null on a clean start. Non-null means the last session did not shut down —
// the UI says so once, because an app that silently vanishes and comes back
// pretending nothing happened is the worst version of this bug.
ipcMain.handle('get-last-crash', () => lastAbnormalExit);

ipcMain.handle('open-logs-folder', () => {
  shell.showItemInFolder(CRASH_LOG);
  return true;
});

// -- playback priority -----------------------------------------------------
//
// The renderer fires this on play, next, seek, seekTo, shuffle and repeat, so a
// scrub drag produces a burst of them. Each one costs a full re-sort of the
// selection list plus an interest recalculation that loops every piece against
// every wire — on the same thread as the torrent engine. Collapse identical
// requests outright and trail the rest.

const PRIORITY_DEBOUNCE_MS = 250;
const priorityTimers = new Map();
const priorityLast = new Map();

function schedulePriority(torrentId, current, next, pinned) {
  const signature = JSON.stringify([current, next, pinned || []]);
  if (priorityLast.get(torrentId) === signature) return;
  priorityLast.set(torrentId, signature);

  clearTimeout(priorityTimers.get(torrentId));
  priorityTimers.set(
    torrentId,
    setTimeout(() => {
      priorityTimers.delete(torrentId);
      torrentService.setPlaybackPriorities(torrentId, current, next, pinned);
    }, PRIORITY_DEBOUNCE_MS)
  );
}

/**
 * Carries the play head as well as the track indices. The position is what lets
 * the readahead window follow the listener instead of sitting at the start of
 * the file; it arrives at ~1 Hz off the media element's timeupdate.
 */
ipcMain.handle('set-playback-state', (event, state) => {
  if (!state || state.torrentId == null) {
    piecePolicy.setPlaybackState(null);
    return;
  }
  schedulePriority(state.torrentId, state.fileIndex, state.nextFileIndex, state.pinned);
  piecePolicy.setPlaybackState({
    torrentId: state.torrentId,
    fileIndex: state.fileIndex,
    nextFileIndex: state.nextFileIndex,
    currentTime: Number(state.currentTime) || 0,
    duration: Number(state.duration) || 0,
  });
});

/**
 * On demand only — this opens real TCP connections to real peers, so it runs
 * when the user asks and never on a timer.
 */
ipcMain.handle('probe-swarm', async (event, torrentId) => {
  const info = torrentService.getSwarmProbeInput(torrentId);
  if (!info) return { error: 'That torrent is not loaded.' };
  try {
    return await swarmProbe.probe(info.infoHash, {
      trackers: info.trackers,
      knownPeers: info.knownPeers,
    });
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('set-active-torrent', (event, torrentId) => {
  torrentService.setActiveTorrent(torrentId);
});

ipcMain.handle('get-diagnostics', (event, torrentId) => {
  const diag = torrentService.getDiagnostics(torrentId);
  if (diag) {
    diag.nat = nat.status();
    diag.policy = piecePolicy.status();
    diag.netPath = netPath.status();
    diag.portFallback = portFallback;
    diag.inboundPeak = diag.inboundPeak || 0;
  }
  return diag;
});

/**
 * Memory, per process, plus what the torrent engine is costing.
 *
 * Exists because the failure mode this app actually has is not a crash — it is
 * the main process growing until macOS compresses and swaps its pages, at which
 * point everything beachballs. `app.getAppMetrics()` is the only way to see the
 * renderer and GPU from in here, and its `memory.workingSetSize` is in KB.
 *
 * `scripts/mem-check.js` measures the same thing from outside with `top` and
 * `vmmap`; this is the version the Net panel can poll.
 */
ipcMain.handle('get-metrics', () => {
  const mem = process.memoryUsage();
  let processes = [];
  try {
    processes = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      // KB in Electron's API; bytes everywhere else in this payload.
      footprintBytes: (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) * 1024,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
    }));
  } catch (_) {
    /* metrics are best-effort; never let them break the panel */
  }
  return {
    main: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      // Buffers live here, not in the JS heap — which is where the piece caches
      // and every wire's read/write buffer actually show up.
      arrayBuffersBytes: mem.arrayBuffers,
      maxEventLoopLagMs: Math.max(0, Math.round(maxLagMs)),
    },
    torrents: torrentService.getMemoryCost(),
    processes: processes,
  };
});

ipcMain.handle('retry-port-mapping', async () => {
  const status = await nat.retry();
  send('nat-status', status);
  return status;
});

// -- network path ----------------------------------------------------------
//
// These are the only entry points that run probes or subprocesses. The 2s
// diagnostics poll reads netPath.status(), which is cached and synchronous.

ipcMain.handle('run-net-preflight', async () => {
  await netPath.refreshFingerprint();
  return netPath.preflight({ force: true });
});

ipcMain.handle('check-public-ip', () => netPath.publicIp());

ipcMain.handle('clear-public-ip', () => {
  netPath.clearPublicIp();
});

ipcMain.handle('remember-home-network', async () => {
  const fp = await netPath.fingerprint();
  if (!fp) {
    return { error: "Couldn't identify this network — no gateway hardware address in the ARP table." };
  }
  setPref('homeNetwork', fp);
  netPath.setHome(fp);
  await netPath.refreshFingerprint();
  return { home: fp };
});

ipcMain.handle('forget-home-network', () => {
  setPref('homeNetwork', null);
  netPath.setHome(null);
  return { home: null };
});

ipcMain.handle('open-torrent-folder', async (event, torrentId) => {
  const folderPath = torrentService.getTorrentPath(torrentId);
  if (!folderPath) return { error: 'Torrent not found' };
  try {
    const err = await shell.openPath(folderPath);
    return err ? { error: err } : { success: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('open-download-folder', async () => {
  const folderPath = torrentService.getDownloadPath();
  try {
    const err = await shell.openPath(folderPath);
    return err ? { error: err } : { success: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});
