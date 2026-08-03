const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const net = require('net');
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
  installStreamCorsHeaders();
  torrentService.setCacheDir(path.join(app.getPath('userData'), 'torrents'));

  const listen = await resolveTorrentPort();
  portFallback = listen.fellBack ? listen.preferred : null;
  await torrentService.start({
    torrentPort: listen.port,
    uploadLimit: getPrefs().uploadLimit,
    secure: getPrefs().peerEncryption !== false,
    trackers,
  });

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
  if (savedPath) {
    torrentService.setDownloadPath(savedPath);
  }

  buildMenu();
  createWindow();

  const savedMagnets = store.get('magnets', []);
  if (savedMagnets.length > 0 && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      send('restore-magnets', savedMagnets);
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
    console.warn('[shutdown] torrent teardown:', err.message);
  }
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
// tags instead — that's what Finder and Music.app are reading. `null` is only
// cached once we've actually parsed a complete file and found nothing, so a
// torrent that simply hasn't downloaded yet gets retried.

const albumArtCache = new Map();

ipcMain.handle('get-album-art', async (event, torrentId) => {
  if (albumArtCache.has(torrentId)) return albumArtCache.get(torrentId);

  const candidates = torrentService.getCompleteAudioPaths(torrentId, 3);
  if (!candidates.length) return null; // nothing complete yet — ask again later

  for (const file of candidates) {
    try {
      const meta = await mm.parseFile(file, { duration: false, skipPostHeaders: true });
      const picture = (meta.common.picture || [])[0];
      if (picture && picture.data && picture.data.length) {
        const url =
          'data:' + (picture.format || 'image/jpeg') + ';base64,' +
          Buffer.from(picture.data).toString('base64');
        const result = { url, artist: meta.common.artist || null, album: meta.common.album || null };
        albumArtCache.set(torrentId, result);
        return result;
      }
    } catch (err) {
      console.warn('[art] could not read tags from', path.basename(file), '-', err.message);
    }
  }

  albumArtCache.set(torrentId, null);
  return null;
});

// -- local-folder fallback -------------------------------------------------

/** Locate the download folder for a torrent we have no metadata for. */
function findLocalFolder(torrentId) {
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
  const direct = path.join(root, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;

  // The folder on disk comes from the .torrent's name, which can differ from
  // the magnet's display name, so fall back to a loose match.
  const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalise(name);
  try {
    const hit = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .find((e) => {
        const n = normalise(e.name);
        return n === target || n.startsWith(target.slice(0, 24)) || target.startsWith(n.slice(0, 24));
      });
    return hit ? path.join(root, hit.name) : null;
  } catch (_) {
    return null;
  }
}

function countMedia(folder) {
  try {
    return fs.readdirSync(folder).filter((f) => AUDIO_RE.test(f)).length;
  } catch (_) {
    return 0;
  }
}

ipcMain.handle('check-local-folder', (event, torrentId) => {
  if (torrentService.hasMetadata(torrentId)) return { available: false };
  const folder = findLocalFolder(torrentId);
  if (!folder) return { available: false };
  const trackCount = countMedia(folder);
  return trackCount > 0
    ? { available: true, path: folder, name: path.basename(folder), trackCount }
    : { available: false };
});

ipcMain.handle('load-from-disk', async (event, torrentId) => {
  const folder = findLocalFolder(torrentId);
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
  await torrentService.remove(torrentId, destroyStore);
  const hash = String(torrentId).toLowerCase();
  const magnets = store.get('magnets', []);
  // Match on the parsed infohash, not a substring of the whole URI — a `dn=` display
  // name could otherwise contain the hash and take an unrelated magnet with it.
  store.set('magnets', magnets.filter((m) => infoHashFromMagnet(m) !== hash));
});

ipcMain.handle('get-download-path', () => torrentService.getDownloadPath());

ipcMain.handle('set-download-path', (event, dir) => {
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
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
