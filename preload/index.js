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

  // The library as recorded on disk, independent of any live torrent. Headers only;
  // track lists are fetched per album, because the full index is megabytes and the
  // UI only ever shows one album's tracks at a time.
  getLibrary: () => ipcRenderer.invoke('get-library'),
  getLibraryTracks: (albumId) => ipcRenderer.invoke('get-library-tracks', albumId),

  // Lifecycle, for when the automatic policy isn't what the user wants: seeding an
  // album that has already archived, or resuming a download queued behind the cap.
  seedAlbum: (albumId) => ipcRenderer.invoke('seed-album', albumId),
  resumeAlbum: (albumId) => ipcRenderer.invoke('resume-album', albumId),
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
  getLastCrash: () => ipcRenderer.invoke('get-last-crash'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),

  // Carries the play head as well as the track indices, so main can size the
  // readahead window around where the listener actually is.
  setPlaybackState: (state) => ipcRenderer.invoke('set-playback-state', state),
  setActiveTorrent: (torrentId) => ipcRenderer.invoke('set-active-torrent', torrentId),

  getDiagnostics: (torrentId) => ipcRenderer.invoke('get-diagnostics', torrentId),
  getMetrics: () => ipcRenderer.invoke('get-metrics'),
  retryPortMapping: () => ipcRenderer.invoke('retry-port-mapping'),

  runNetPreflight: () => ipcRenderer.invoke('run-net-preflight'),
  checkPublicIp: () => ipcRenderer.invoke('check-public-ip'),
  clearPublicIp: () => ipcRenderer.invoke('clear-public-ip'),
  probeSwarm: (torrentId) => ipcRenderer.invoke('probe-swarm', torrentId),
  rememberHomeNetwork: () => ipcRenderer.invoke('remember-home-network'),
  forgetHomeNetwork: () => ipcRenderer.invoke('forget-home-network'),

  openTorrentFolder: (torrentId) => ipcRenderer.invoke('open-torrent-folder', torrentId),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),

  onTorrentReady: subscribe('torrent-ready'),
  onTorrentProgress: subscribe('torrent-progress'),
  onRestoreMagnets: subscribe('restore-magnets'),
  onLibraryUnavailable: subscribe('library-unavailable'),
  onTorrentError: subscribe('torrent-error'),
  onNatStatus: subscribe('nat-status'),
  onMenuCommand: subscribe('menu-command'),
});
