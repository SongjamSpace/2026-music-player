const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { TorrentService, DEFAULT_DOWNLOAD_PATH } = require('./torrent-service');

const store = new Store();
const torrentService = new TorrentService();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.on('did-finish-load', () => {
    const streamBaseURL = torrentService.getStreamBaseURL();
    if (streamBaseURL) {
      mainWindow.webContents.send('stream-base-url', streamBaseURL);
    }
  });
}

app.whenReady().then(async () => {
  await torrentService.start();

  const savedPath = store.get('downloadPath');
  if (savedPath) {
    torrentService.setDownloadPath(savedPath);
  }

  createWindow();

  const savedMagnets = store.get('magnets', []);
  if (savedMagnets.length > 0 && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('restore-magnets', savedMagnets);
    });
  }
});

app.on('window-all-closed', () => {
  torrentService.destroy();
  app.quit();
});

ipcMain.handle('get-stream-base-url', () => {
  return torrentService.getStreamBaseURL();
});

ipcMain.handle('add-torrent', async (event, magnetUri) => {
  const onTorrentReady = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('torrent-ready', data);
    }
    const magnets = store.get('magnets', []);
    if (!magnets.includes(magnetUri)) {
      magnets.push(magnetUri);
      store.set('magnets', magnets);
    }
  };
  const onProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('torrent-progress', data);
    }
  };
  const onError = (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('torrent-error', { message: err.message || String(err) });
    }
  };
  try {
    await torrentService.add(magnetUri, onTorrentReady, onProgress, onError);
    return { success: true, pending: true };
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('get-torrents', () => {
  return torrentService.getTorrents();
});

ipcMain.handle('remove-torrent', async (event, torrentId, destroyStore) => {
  await torrentService.remove(torrentId, destroyStore);
  const magnets = store.get('magnets', []);
  store.set(
    'magnets',
    magnets.filter((m) => {
      const hash = torrentId.toLowerCase();
      return !m.toLowerCase().includes(hash);
    })
  );
});

ipcMain.handle('get-download-path', () => {
  return torrentService.getDownloadPath();
});

ipcMain.handle('set-download-path', (event, dir) => {
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
});

ipcMain.handle('get-default-download-path', () => {
  return DEFAULT_DOWNLOAD_PATH;
});

ipcMain.handle('set-playback-priority', (event, torrentId, currentFileIndex, nextFileIndex) => {
  torrentService.setFilePriorities(torrentId, currentFileIndex, nextFileIndex);
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
