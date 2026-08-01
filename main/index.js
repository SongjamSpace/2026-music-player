const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const mm = require('music-metadata');
const {
  TorrentService,
  DEFAULT_DOWNLOAD_PATH,
  infoHashFromMagnet,
  AUDIO_RE,
} = require('./torrent-service');

const store = new Store();
const torrentService = new TorrentService();

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
};

let mainWindow = null;

function getPrefs() {
  return Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
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
    mainWindow.webContents.on('render-process-gone', (e, details) => {
      console.error('[renderer] gone:', details.reason);
    });
  }
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

app.whenReady().then(async () => {
  installStreamCorsHeaders();
  torrentService.setCacheDir(path.join(app.getPath('userData'), 'torrents'));
  await torrentService.start();

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

app.on('window-all-closed', () => {
  torrentService.destroy();
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
  const prefs = getPrefs();
  prefs[key] = value;
  store.set('prefs', prefs);
  return prefs;
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-playback-priority', (event, torrentId, currentFileIndex, nextFileIndex, pinned) => {
  torrentService.setFilePriorities(torrentId, currentFileIndex, nextFileIndex, pinned);
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
