const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playerAPI', {
  getStreamBaseURL: () => ipcRenderer.invoke('get-stream-base-url'),
  addTorrent: (magnetUri) => ipcRenderer.invoke('add-torrent', magnetUri),
  getTorrents: () => ipcRenderer.invoke('get-torrents'),
  removeTorrent: (torrentId, destroyStore) =>
    ipcRenderer.invoke('remove-torrent', torrentId, destroyStore),
  getDownloadPath: () => ipcRenderer.invoke('get-download-path'),
  setDownloadPath: (dir) => ipcRenderer.invoke('set-download-path', dir),
  getDefaultDownloadPath: () => ipcRenderer.invoke('get-default-download-path'),
  setPlaybackPriority: (torrentId, currentFileIndex, nextFileIndex) =>
    ipcRenderer.invoke('set-playback-priority', torrentId, currentFileIndex, nextFileIndex),
  openTorrentFolder: (torrentId) => ipcRenderer.invoke('open-torrent-folder', torrentId),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),

  onStreamBaseURL: (cb) => {
    ipcRenderer.on('stream-base-url', (event, url) => cb(url));
  },
  onTorrentReady: (cb) => {
    ipcRenderer.on('torrent-ready', (event, data) => cb(data));
  },
  onTorrentProgress: (cb) => {
    ipcRenderer.on('torrent-progress', (event, data) => cb(data));
  },
  onRestoreMagnets: (cb) => {
    ipcRenderer.on('restore-magnets', (event, magnets) => cb(magnets));
  },
  onTorrentError: (cb) => {
    ipcRenderer.on('torrent-error', (event, data) => cb(data));
  },
});
