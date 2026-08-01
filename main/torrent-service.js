const WebTorrent = require('webtorrent');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DOWNLOAD_PATH = path.join(os.homedir(), 'Music', '2026-Music-Player');

const AUDIO_RE = /\.(mp3|m4a|flac|ogg|oga|opus|aac|wav)$/i;

/** Pull the 40-hex infohash out of a magnet URI. Returns null for base32 or malformed. */
function infoHashFromMagnet(magnetUri) {
  const match = /xt=urn:btih:([a-fA-F0-9]{40})/.exec(magnetUri || '');
  return match ? match[1].toLowerCase() : null;
}

class TorrentService {
  constructor() {
    this.client = null;
    this.downloadPath = DEFAULT_DOWNLOAD_PATH;
    this.torrentServers = new Map();
    this.torrentServerUrls = new Map();
    this.cacheDir = null;

    // A torrent seeded from already-downloaded files gets a fresh infohash that
    // won't match the magnet the library entry is keyed by. These keep the
    // public id (the magnet's hash) stable across that swap.
    this.aliases = new Map(); // publicId -> real infoHash
    this.publicIds = new Map(); // real infoHash -> publicId
  }

  // -- metadata cache ------------------------------------------------------
  //
  // A magnet carries no file list — that has to come from a peer. Without this
  // cache, an album that is already fully downloaded stays unopenable whenever
  // its swarm is offline, which is the normal end state for an old torrent.

  setCacheDir(dir) {
    this.cacheDir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn('[torrent] could not create metadata cache:', err.message);
      this.cacheDir = null;
    }
  }

  _cachePath(infoHash, local) {
    const suffix = local ? '.local.torrent' : '.torrent';
    return path.join(this.cacheDir, String(infoHash).toLowerCase() + suffix);
  }

  _readCachedMetadata(infoHash, local) {
    if (!this.cacheDir || !infoHash) return null;
    try {
      return fs.readFileSync(this._cachePath(infoHash, local));
    } catch (_) {
      return null;
    }
  }

  _writeCachedMetadata(torrent, publicId, local) {
    if (!this.cacheDir || !torrent.torrentFile) return;
    try {
      fs.writeFileSync(this._cachePath(publicId || torrent.infoHash, local), torrent.torrentFile);
    } catch (err) {
      console.warn('[torrent] could not cache metadata:', err.message);
    }
  }

  _deleteCachedMetadata(infoHash) {
    if (!this.cacheDir || !infoHash) return;
    [false, true].forEach((local) => {
      try {
        fs.unlinkSync(this._cachePath(infoHash, local));
      } catch (_) {
        /* nothing cached */
      }
    });
  }

  // -- lifecycle -----------------------------------------------------------

  async start() {
    this.client = new WebTorrent();
    return Promise.resolve();
  }

  /** Map a library id onto the actual torrent, following any local-seed alias. */
  _get(publicId) {
    if (!this.client) return null;
    return this.client.get(this.aliases.get(publicId) || publicId) || null;
  }

  has(torrentId) {
    return !!this._get(torrentId);
  }

  /**
   * Whether we actually know this torrent's file list. `has()` is true the
   * instant a magnet is added, long before any peer supplies metadata — so the
   * two are very different questions and conflating them hides stuck torrents.
   */
  hasMetadata(torrentId) {
    const t = this._get(torrentId);
    return !!(t && t.files && t.files.length);
  }

  setDownloadPath(dir) {
    this.downloadPath = dir || DEFAULT_DOWNLOAD_PATH;
  }

  getDownloadPath() {
    return this.downloadPath;
  }

  // -- shared wiring -------------------------------------------------------

  _describeFiles(torrent, baseUrl) {
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

  /**
   * Stand up the streaming server for a ready torrent and start reporting on
   * it. Shared by magnet/​.torrent adds and by local-folder seeding, so both
   * paths produce identical payloads to the renderer.
   */
  _activate(t, publicId, { onTorrentReady, onProgress }) {
    const server = t.createServer();
    this.torrentServers.set(publicId, server);

    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      this.torrentServerUrls.set(publicId, baseUrl);

      onTorrentReady({
        id: publicId,
        name: t.name,
        magnetURI: t.magnetURI,
        files: this._describeFiles(t, baseUrl),
        progress: t.progress,
        numPeers: t.numPeers,
        downloadSpeed: t.downloadSpeed,
        timeRemaining: t.timeRemaining,
        done: t.done,
        fileProgress: t.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
      });

      const progressInterval = setInterval(() => {
        if (t.destroyed) {
          clearInterval(progressInterval);
          return;
        }
        onProgress({
          id: publicId,
          progress: t.progress,
          numPeers: t.numPeers,
          downloadSpeed: t.downloadSpeed,
          timeRemaining: t.timeRemaining,
          downloaded: t.downloaded,
          length: t.length,
          fileProgress: t.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
        });
      }, 500);

      const emitDone = () => {
        clearInterval(progressInterval);
        onProgress({
          id: publicId,
          progress: 1,
          numPeers: t.numPeers,
          downloadSpeed: t.downloadSpeed,
          timeRemaining: 0,
          downloaded: t.downloaded,
          length: t.length,
          done: true,
          fileProgress: t.files.map((f) => ({ progress: 1, downloaded: f.length })),
        });
      };

      // A torrent restored from cached metadata with its files already on disk
      // can finish verifying before we get here, so 'done' would never fire.
      if (t.done) emitDone();
      else t.on('done', emitDone);
    });
  }

  // -- adding --------------------------------------------------------------

  add(magnetUri, onTorrentReady, onProgress, onError) {
    if (!this.client) return Promise.reject(new Error('Torrent service not started'));

    const publicId = infoHashFromMagnet(magnetUri);
    const opts = { path: this.downloadPath };

    // Prefer cached metadata — it makes the file list available immediately and
    // offline. `.local.torrent` is one we generated from the user's own files
    // when the swarm was unreachable; it describes the same content under a
    // different infohash, so it needs the alias.
    const exact = this._readCachedMetadata(publicId, false);
    const local = exact ? null : this._readCachedMetadata(publicId, true);
    const source = exact || local || magnetUri;
    if (local) Object.assign(opts, { announce: [] });

    return new Promise((resolve, reject) => {
      let resolved = false;
      try {
        const torrent = this.client.add(source, opts, (t) => {
          const id = publicId || t.infoHash;
          if (t.infoHash !== id) {
            this.aliases.set(id, t.infoHash);
            this.publicIds.set(t.infoHash, id);
          }
          if (!local) this._writeCachedMetadata(t, id, false);
          this._activate(t, id, { onTorrentReady, onProgress });
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

  /**
   * Last resort for a torrent whose swarm is gone: the files are already on
   * disk, so hash them into a fresh local-only torrent and serve from that.
   * Keeps the library id stable via the alias map, and caches the generated
   * .torrent so it resolves instantly on later launches.
   */
  async seedFromDisk(publicId, folderPath, onTorrentReady, onProgress, onError) {
    if (!this.client) throw new Error('Torrent service not started');
    if (this.hasMetadata(publicId)) throw new Error('Torrent is already loaded');
    if (!fs.existsSync(folderPath)) throw new Error('Folder not found on disk');

    // Drop the metadata-less magnet first so it stops announcing into a dead
    // swarm and can't collide with the entry we're about to create.
    if (this.has(publicId)) {
      try {
        await this.client.remove(this.aliases.get(publicId) || publicId, { destroyStore: false });
      } catch (_) {
        /* already gone */
      }
    }

    return new Promise((resolve, reject) => {
      try {
        // announce: [] keeps this strictly local — we are not advertising a
        // new swarm, just reading the user's own files.
        const torrent = this.client.seed(
          folderPath,
          { path: path.dirname(folderPath), announce: [] },
          (t) => {
            this.aliases.set(publicId, t.infoHash);
            this.publicIds.set(t.infoHash, publicId);
            this._writeCachedMetadata(t, publicId, true);
            this._activate(t, publicId, { onTorrentReady, onProgress });
            resolve({ seeded: true, fileCount: t.files.length });
          }
        );
        torrent.on('error', (err) => {
          if (typeof onError === 'function') onError(err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // -- reading -------------------------------------------------------------

  _fileListWithStreamUrls(torrent, publicId) {
    const baseUrl = this.torrentServerUrls.get(publicId);
    if (!baseUrl) {
      return torrent.files.map((f) => ({
        name: f.name,
        path: f.path,
        length: f.length,
        streamURL: null,
        type: f.type || 'application/octet-stream',
        progress: f.progress,
        downloaded: f.downloaded,
      }));
    }
    return this._describeFiles(torrent, baseUrl);
  }

  getTorrents() {
    if (!this.client) return [];
    return this.client.torrents.map((torrent) => {
      const publicId = this.publicIds.get(torrent.infoHash) || torrent.infoHash;
      return {
        id: publicId,
        name: torrent.name,
        magnetURI: torrent.magnetURI,
        files: this._fileListWithStreamUrls(torrent, publicId),
        progress: torrent.progress,
        numPeers: torrent.numPeers,
        downloadSpeed: torrent.downloadSpeed,
        timeRemaining: torrent.timeRemaining,
        done: torrent.done,
        fileProgress: torrent.files.map((f) => ({ progress: f.progress, downloaded: f.downloaded })),
      };
    });
  }

  /** Absolute on-disk paths of complete audio files, for tag/artwork reading. */
  getCompleteAudioPaths(torrentId, limit = 3) {
    const t = this._get(torrentId);
    if (!t) return [];
    const out = [];
    for (const file of t.files) {
      if (out.length >= limit) break;
      if (file.progress >= 1 && AUDIO_RE.test(file.name)) {
        out.push(path.join(t.path, file.path));
      }
    }
    return out;
  }

  /**
   * Keep only the current and next tracks selected so bandwidth follows
   * playback. `pinnedIndices` survives that cull — used for cover art, which is
   * tiny but would otherwise never download once playback starts.
   */
  setFilePriorities(torrentId, currentFileIndex, nextFileIndex, pinnedIndices) {
    const torrent = this._get(torrentId);
    if (!torrent || !torrent.files.length) return;
    const keep = new Set([currentFileIndex, nextFileIndex]);
    if (Array.isArray(pinnedIndices)) pinnedIndices.forEach((i) => keep.add(i));
    torrent.files.forEach((file, i) => {
      if (keep.has(i)) {
        file.select(1);
      } else {
        file.deselect();
      }
    });
  }

  getTorrentPath(torrentId) {
    const torrent = this._get(torrentId);
    return torrent ? torrent.path || null : null;
  }

  async remove(torrentId, destroyStore = false) {
    if (!this.client) return;
    const server = this.torrentServers.get(torrentId);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      this.torrentServers.delete(torrentId);
      this.torrentServerUrls.delete(torrentId);
    }
    this._deleteCachedMetadata(torrentId);
    const real = this.aliases.get(torrentId) || torrentId;
    this.aliases.delete(torrentId);
    this.publicIds.delete(real);
    await this.client.remove(real, { destroyStore });
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

module.exports = { TorrentService, DEFAULT_DOWNLOAD_PATH, infoHashFromMagnet, AUDIO_RE };
