const WebTorrent = require('webtorrent');
const path = require('path');
const os = require('os');

const DEFAULT_DOWNLOAD_PATH = path.join(os.homedir(), 'Music', '2026-Music-Player');

class TorrentService {
  constructor() {
    this.client = null;
    this.downloadPath = DEFAULT_DOWNLOAD_PATH;
    this.torrentServers = new Map();
    this.torrentServerUrls = new Map();
  }

  async start() {
    this.client = new WebTorrent();
    return Promise.resolve();
  }

  getStreamBaseURL() {
    return null;
  }

  setDownloadPath(dir) {
    this.downloadPath = dir || DEFAULT_DOWNLOAD_PATH;
  }

  getDownloadPath() {
    return this.downloadPath;
  }

  add(magnetUri, onTorrentReady, onProgress, onError) {
    if (!this.client) return Promise.reject(new Error('Torrent service not started'));

    const opts = {
      path: this.downloadPath,
    };

    return new Promise((resolve, reject) => {
      let resolved = false;
      try {
        const torrent = this.client.add(magnetUri, opts, (t) => {
          const torrentId = t.infoHash;

          const server = t.createServer();
          this.torrentServers.set(torrentId, server);

          server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const baseUrl = `http://127.0.0.1:${port}`;
            this.torrentServerUrls.set(torrentId, baseUrl);

            const files = t.files.map((file, index) => ({
              name: file.name,
              path: file.path,
              length: file.length,
              streamURL: `${baseUrl}/${index}/${encodeURIComponent(file.name)}`,
              type: file.type || 'application/octet-stream',
              progress: file.progress,
              downloaded: file.downloaded,
            }));

            onTorrentReady({
              id: torrentId,
              name: t.name,
              magnetURI: t.magnetURI,
              files,
              progress: t.progress,
              numPeers: t.numPeers,
              downloadSpeed: t.downloadSpeed,
              timeRemaining: t.timeRemaining,
              fileProgress: t.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
            });

            const progressInterval = setInterval(() => {
              if (t.destroyed) {
                clearInterval(progressInterval);
                return;
              }
              onProgress({
                id: torrentId,
                progress: t.progress,
                numPeers: t.numPeers,
                downloadSpeed: t.downloadSpeed,
                timeRemaining: t.timeRemaining,
                downloaded: t.downloaded,
                length: t.length,
                fileProgress: t.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
              });
            }, 500);

            t.on('done', () => {
              clearInterval(progressInterval);
              onProgress({
                id: torrentId,
                progress: 1,
                numPeers: t.numPeers,
                downloadSpeed: t.downloadSpeed,
                timeRemaining: 0,
                downloaded: t.downloaded,
                length: t.length,
                done: true,
                fileProgress: t.files.map((f) => ({ progress: 1, downloaded: f.length })),
              });
            });
          });
        });
        torrent.on('error', (err) => {
          if (typeof onError === 'function') onError(err);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
        resolve({ added: true });
        resolved = true;
      } catch (err) {
        reject(err);
      }
    });
  }

  _fileListWithStreamUrls(torrent) {
    const baseUrl = this.torrentServerUrls.get(torrent.infoHash);
    if (!baseUrl) return torrent.files.map((f, i) => ({ name: f.name, path: f.path, length: f.length, streamURL: null, type: f.type || 'application/octet-stream', progress: f.progress, downloaded: f.downloaded }));
    return torrent.files.map((file, index) => ({
      name: file.name,
      path: file.path,
      length: file.length,
      streamURL: `${baseUrl}/${index}/${encodeURIComponent(file.name)}`,
      type: file.type || 'application/octet-stream',
      progress: file.progress,
      downloaded: file.downloaded,
    }));
  }

  getTorrents() {
    if (!this.client) return [];
    return this.client.torrents.map((torrent) => ({
      id: torrent.infoHash,
      name: torrent.name,
      magnetURI: torrent.magnetURI,
      files: this._fileListWithStreamUrls(torrent),
      progress: torrent.progress,
      numPeers: torrent.numPeers,
      downloadSpeed: torrent.downloadSpeed,
      timeRemaining: torrent.timeRemaining,
      done: torrent.done,
      fileProgress: torrent.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
    }));
  }

  setFilePriorities(torrentId, currentFileIndex, nextFileIndex) {
    if (!this.client) return;
    const torrent = this.client.get(torrentId);
    if (!torrent || !torrent.files.length) return;
    torrent.files.forEach((file, i) => {
      if (i === currentFileIndex || i === nextFileIndex) {
        file.select(1);
      } else {
        file.deselect();
      }
    });
  }

  getTorrentPath(torrentId) {
    if (!this.client) return null;
    const torrent = this.client.get(torrentId);
    if (!torrent) return null;
    return torrent.path || null;
  }

  async remove(torrentId, destroyStore = false) {
    if (!this.client) return;
    const server = this.torrentServers.get(torrentId);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      this.torrentServers.delete(torrentId);
      this.torrentServerUrls.delete(torrentId);
    }
    await this.client.remove(torrentId, { destroyStore });
  }

  destroy() {
    this.torrentServers.forEach((server) => {
      try {
        server.close();
      } catch (_) {}
    });
    this.torrentServers.clear();
    this.torrentServerUrls.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

module.exports = { TorrentService, DEFAULT_DOWNLOAD_PATH };
