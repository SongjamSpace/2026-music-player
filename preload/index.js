const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wraps an ipcRenderer channel subscription so callers get a real unsubscribe
 * function back. The renderer's api.js is the only place allowed to call these,
 * exactly once per channel — everything downstream subscribes through its fan-out.
 */
function subscribe(channel) {
  return (cb) => {
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const themeArg = process.argv.find((a) => a.startsWith('--mp-theme='));

contextBridge.exposeInMainWorld('playerAPI', {
  // Read synchronously at boot so the theme can be applied before first paint.
  initialTheme: themeArg ? themeArg.slice('--mp-theme='.length) : 'midnight',

  addTorrent: (magnetUri) => ipcRenderer.invoke('add-torrent', magnetUri),
  getTorrents: () => ipcRenderer.invoke('get-torrents'),
  removeTorrent: (torrentId, destroyStore) =>
    ipcRenderer.invoke('remove-torrent', torrentId, destroyStore),

  getDownloadPath: () => ipcRenderer.invoke('get-download-path'),
  setDownloadPath: (dir) => ipcRenderer.invoke('set-download-path', dir),
  getDefaultDownloadPath: () => ipcRenderer.invoke('get-default-download-path'),
  chooseDownloadPath: () => ipcRenderer.invoke('choose-download-path'),

  getAlbumArt: (torrentId) => ipcRenderer.invoke('get-album-art', torrentId),
  checkLocalFolder: (torrentId) => ipcRenderer.invoke('check-local-folder', torrentId),
  loadFromDisk: (torrentId) => ipcRenderer.invoke('load-from-disk', torrentId),

  getPrefs: () => ipcRenderer.invoke('get-prefs'),
  setPref: (key, value) => ipcRenderer.invoke('set-pref', key, value),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  setPlaybackPriority: (torrentId, currentFileIndex, nextFileIndex, pinned) =>
    ipcRenderer.invoke('set-playback-priority', torrentId, currentFileIndex, nextFileIndex, pinned),

  openTorrentFolder: (torrentId) => ipcRenderer.invoke('open-torrent-folder', torrentId),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),

  onTorrentReady: subscribe('torrent-ready'),
  onTorrentProgress: subscribe('torrent-progress'),
  onRestoreMagnets: subscribe('restore-magnets'),
  onTorrentError: subscribe('torrent-error'),
  onMenuCommand: subscribe('menu-command'),
});
