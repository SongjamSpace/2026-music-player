const WebTorrent = require('webtorrent');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DOWNLOAD_PATH = path.join(os.homedir(), 'Music', '2026-Music-Player');

const AUDIO_RE = /\.(mp3|m4a|flac|ogg|oga|opus|aac|wav)$/i;

// -- tuning ----------------------------------------------------------------

/**
 * Per torrent, not client-wide: webtorrent's `_drain()` compares each torrent's
 * own connection count against `client.maxConns`. The library default of 55
 * binds on any healthy swarm; qBittorrent ships 100 per torrent. Watch for
 * EMFILE with several torrents live and drop this to 80 if it appears.
 */
const MAX_CONNS = 120;

/**
 * Counter-intuitive, but capping upload makes downloads faster on an
 * asymmetric residential line: a saturated uplink queues TCP ACKs and starves
 * uTP's LEDBAT delay estimator. Not 0 — webtorrent enables the throttle group
 * at rate 0, which blocks upload entirely and gets you snubbed under tit-for-tat.
 */
const DEFAULT_UPLOAD_LIMIT = 1500000; // ~12 Mbps

const MAX_WEB_CONNS = 10; // default 4 — archive.org web seeds are latency-bound
const UPLOAD_SLOTS = 14; // default 10 rechoke slots; more reciprocation
const STORE_CACHE_SLOTS = 64; // default 20 — LRU of whole pieces

/**
 * Selection priorities for playback.
 *
 * These must never be 1. WebTorrent's own FileStream selects the range it is
 * reading at priority 1 (`lib/file-stream.js`), and `torrent.deselect` splices
 * the *first* entry matching (from, to, priority) — so sharing a priority with
 * the stream server means one of us silently cancels the other's selection.
 * 0 is equally unusable: that's the whole-torrent base selection.
 */
const PRI_PINNED = 9; // cover art — kilobytes, but starved forever without this
const PRI_CURRENT = 7;
const PRI_NEXT = 5;

const PROGRESS_TICK_MS = 1000;
/** Per-file progress is O(pieces); the torrent-level numbers are O(1). */
const FILE_PROGRESS_EVERY = 4; // ticks

/** Escape hatch for A/B measurement — reproduces the original zero-option client. */
const BASELINE = process.env.MP_TORRENT_PROFILE === 'baseline';

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

    this.trackers = null; // set by start(); see main/trackers.js

    // Playback priority selections, tracked so they can actually be undone.
    // real infoHash -> Map<fileIndex, {from, to, priority}>
    this.selectionState = new Map();
    // Requests that arrived before metadata, replayed on 'ready'.
    this.pendingSelections = new Map();

    // Progress reporting. One shared interval, not one per torrent.
    this.ticker = null;
    this.reporters = new Map(); // publicId -> { onProgress, doneReported }
    this.fileProgressCache = new Map(); // publicId -> (entry|null)[] for finished files
    this.activeTorrentId = null; // whose file list the UI is showing

    // Most inbound peers seen at once, across all torrents, since launch. A
    // live count of 0 proves nothing — peers come and go — but "one ever
    // connected in" is proof the forwarded port works, and that is the single
    // fact that decides whether small swarms will ever move.
    this.inboundPeak = 0;

    // Set if the WebTorrent client ever errors. A listen-socket error destroys
    // the client outright, so this is the difference between "the swarm is
    // quiet" and "nothing will ever download again until you restart".
    this.clientError = null;
    this.onClientError = null;
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

  _modtimesPath(infoHash) {
    return path.join(this.cacheDir, String(infoHash).toLowerCase() + '.modtimes.json');
  }

  /**
   * File modification times as of the last time we knew the data was good.
   *
   * WebTorrent re-hashes every byte of every restored torrent on launch unless
   * it is handed these — so a library of finished albums spends minutes pinning
   * the same thread the downloader runs on, at exactly the moment the user
   * wants to press play. With them, an untouched file set is trusted after a
   * stat() per file.
   *
   * Deliberately not `skipVerify: true`, which trusts the disk blindly: a
   * truncated or externally edited file would be served as valid audio.
   */
  _readCachedModtimes(infoHash) {
    if (!this.cacheDir || !infoHash) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._modtimesPath(infoHash), 'utf8'));
      return Array.isArray(parsed) ? parsed : undefined;
    } catch (_) {
      return undefined;
    }
  }

  _writeCachedModtimes(torrent, publicId) {
    if (!this.cacheDir || !torrent || typeof torrent.getFileModtimes !== 'function') return;
    torrent.getFileModtimes((err, modtimes) => {
      if (err || !modtimes) return;
      try {
        fs.writeFileSync(this._modtimesPath(publicId || torrent.infoHash), JSON.stringify(modtimes));
      } catch (writeErr) {
        console.warn('[torrent] could not cache modtimes:', writeErr.message);
      }
    });
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
    const paths = [this._cachePath(infoHash, false), this._cachePath(infoHash, true), this._modtimesPath(infoHash)];
    paths.forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (_) {
        /* nothing cached */
      }
    });
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * @param {object} opts
   * @param {number} opts.torrentPort  Fixed listen port. Never 0 in normal use —
   *   an ephemeral port cannot be forwarded, and peers that learned our address
   *   via DHT or PEX can never reconnect after a restart.
   * @param {number=} opts.uploadLimit  Bytes/sec, or -1 for unlimited.
   * @param {object=} opts.trackers  A createTrackers() instance.
   */
  async start(opts = {}) {
    this.trackers = opts.trackers || null;

    if (BASELINE) {
      console.warn('[torrent] MP_TORRENT_PROFILE=baseline — running with library defaults');
      this.client = new WebTorrent();
    } else {
      const torrentPort = opts.torrentPort || 0;
      this.client = new WebTorrent({
        maxConns: MAX_CONNS,
        torrentPort,
        // Must differ from torrentPort: webtorrent binds the uTP server on the
        // same numeric port as TCP, over UDP, so DHT would collide with it.
        dhtPort: torrentPort ? torrentPort + 1 : 0,
        // Off by default, and this is a stability decision, not a performance
        // one. utp-native 2.5.3 (a transitive dep of webtorrent 1.9.7) has a
        // use-after-free: libutp's 500 ms timeout sweep can free a UTPSocket
        // and then fire its state-change callback into JS on the freed object.
        //
        //   utp_check_timeouts -> ~UTPSocket() -> utp_call_on_state_change
        //     -> napi_make_callback -> SIGSEGV on CrBrowserMain
        //
        // That is a native segfault, so no uncaughtException handler can catch
        // it and the app vanishes without writing anything. It was always
        // latent — webtorrent enables uTP whenever utp-native is installed
        // (index.js:81, `opts.utp !== false`) — but raising maxConns and
        // getting inbound working on a forwarded port multiplied the socket
        // churn enough to hit it regularly.
        //
        // Losing uTP costs the uTP-only peers in a swarm. TCP inbound on the
        // forwarded port is unaffected and remains the bulk of the peers.
        utp: opts.utp === true,
        // MSE/RC4 protocol obfuscation. Not privacy — every peer still sees our
        // address, and DHT and tracker traffic stay in the clear — but it
        // defeats protocol-signature shaping, which is a common cause of a
        // download that starts fast and then collapses.
        //
        // Three caveats the UI has to repeat, because none of them are obvious:
        //  - TCP only. bittorrent-protocol runs the PE handshake for
        //    tcpIncoming/tcpOutgoing and nothing else, so uTP peers are plaintext.
        //  - A peer whose encrypted connect fails is retried in the clear, so
        //    the encrypted fraction never reaches 100%.
        //  - enableSecure() flips a module-level global in webtorrent/lib/peer.js
        //    with no way to unset it, so this is restart-only in both directions.
        secure: opts.secure !== false,
        downloadLimit: -1,
        uploadLimit: typeof opts.uploadLimit === 'number' ? opts.uploadLimit : DEFAULT_UPLOAD_LIMIT,
      });
    }

    // The effective value, as distinct from the pref — they diverge until the
    // next restart, and that gap is exactly what the Settings row must show.
    this.secure = !BASELINE && opts.secure !== false;

    // Without a listener webtorrent rethrows, taking the whole main process
    // (and playback) down over something like a single bad tracker URL.
    //
    // Worse, this is not merely informational: any error on the listen socket
    // runs `client._destroy(err)` (lib/conn-pool.js:41), which tears down the
    // entire client. Every torrent stops, and every later call throws "client
    // is destroyed". Logging alone made that look identical to a dead swarm —
    // hours of nothing with no explanation — so the state is recorded and
    // surfaced instead of swallowed.
    this.client.on('error', (err) => {
      const message = (err && err.message) || String(err);
      console.error('[torrent] client error:', message);
      this.clientError = { message, at: Date.now(), fatal: !!this.client && this.client.destroyed };
      if (typeof this.onClientError === 'function') this.onClientError(this.clientError);
    });

    return Promise.resolve();
  }

  /** Shared add options for both the magnet and local-seed paths. */
  _addOpts({ local, publicId }) {
    // `announce: []` is not a tuning choice and stays in every profile: without
    // it, create-torrent injects its own default tracker list and a local-only
    // seed of the user's own files gets advertised to the public internet.
    if (BASELINE) return { path: this.downloadPath, announce: local ? [] : undefined };
    return {
      path: this.downloadPath,
      fileModtimes: this._readCachedModtimes(publicId),
      // Phase 3 flips this at runtime once the play head has a buffer.
      strategy: 'sequential',
      maxWebConns: MAX_WEB_CONNS,
      uploads: UPLOAD_SLOTS,
      storeCacheSlots: STORE_CACHE_SLOTS,
      // A local seed is deliberately not advertised anywhere.
      announce: local || !this.trackers ? [] : this.trackers.list(),
    };
  }

  /** @param {number} bytesPerSecond  -1 for unlimited. */
  setUploadLimit(bytesPerSecond) {
    if (!this.client || BASELINE) return;
    this.client.throttleUpload(typeof bytesPerSecond === 'number' ? bytesPerSecond : -1);
  }

  get torrentPort() {
    return this.client ? this.client.torrentPort : null;
  }

  get dhtPort() {
    if (!this.client || !this.client.dht) return null;
    try {
      return this.client.dht.address().port; // throws until the socket is bound
    } catch (_) {
      return null;
    }
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

  // -- progress reporting ----------------------------------------------------
  //
  // One shared ticker for every torrent rather than an interval each, and a
  // hard split between cheap and expensive fields.
  //
  // `file.progress` is not a getter over a counter — it walks every piece in
  // the file against the bitfield. Recomputing it for every file of every
  // torrent twice a second put an O(total pieces) loop on the same thread as
  // the wire protocol and the piece picker, competing with the thing it was
  // measuring. Now: torrent-level numbers (all O(1)) every second, per-file
  // numbers only for the torrent actually on screen, only every fourth tick,
  // and never again for a file that has already finished.

  /** @param {string|null} publicId  The torrent whose file list is on screen. */
  setActiveTorrent(publicId) {
    this.activeTorrentId = publicId;
  }

  _fileProgressFor(publicId, torrent) {
    let memo = this.fileProgressCache.get(publicId);
    if (!memo || memo.length !== torrent.files.length) {
      memo = torrent.files.map(() => null);
      this.fileProgressCache.set(publicId, memo);
    }
    return torrent.files.map((file, i) => {
      // A finished file cannot change, so never walk its pieces again.
      if (memo[i]) return memo[i];
      const entry = { progress: file.progress, downloaded: file.downloaded };
      if (entry.progress >= 1) memo[i] = entry;
      return entry;
    });
  }

  _startTicker() {
    if (this.ticker) return;
    let tick = 0;
    this.ticker = setInterval(() => {
      tick++;
      const wantFiles = tick % FILE_PROGRESS_EVERY === 0;
      // Sampled here rather than only in getDiagnostics: the peak has to keep
      // accumulating while nobody has Settings open, or the first inbound peer
      // of the session goes unrecorded.
      this._sampleInbound();

      for (const [publicId, entry] of this.reporters) {
        // Per-torrent, because one torrent tearing down mid-tick must not stop
        // the other seven from reporting — and an uncaught throw in here would
        // end the main process outright, losing playback over a status update.
        try {
          const t = this._get(publicId);
          if (!t || t.destroyed) {
            this.reporters.delete(publicId);
            this.fileProgressCache.delete(publicId);
            continue;
          }

          const payload = {
            id: publicId,
            progress: t.progress,
            numPeers: t.numPeers,
            downloadSpeed: t.downloadSpeed,
            uploadSpeed: t.uploadSpeed,
            timeRemaining: t.timeRemaining,
            downloaded: t.downloaded,
            length: t.length,
          };

          // Newly finished torrents get one final full payload so the UI settles
          // on exact numbers rather than whatever the last sampled tick showed.
          if (t.done && !entry.doneReported) {
            entry.doneReported = true;
            payload.progress = 1;
            payload.timeRemaining = 0;
            payload.done = true;
            payload.fileProgress = t.files.map((f) => ({ progress: 1, downloaded: f.length }));
          } else if (wantFiles && publicId === this.activeTorrentId) {
            payload.fileProgress = this._fileProgressFor(publicId, t);
          }

          entry.onProgress(payload);
        } catch (err) {
          console.error('[torrent] progress tick failed for', publicId, '-', err.message);
        }
      }

      if (!this.reporters.size) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
    }, PROGRESS_TICK_MS);
    if (this.ticker.unref) this.ticker.unref();
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
        fileProgress: this._fileProgressFor(publicId, t),
      });

      // A torrent restored from cached metadata with its files already on disk
      // can finish verifying before we get here, so waiting on 'done' alone
      // would never fire. The ticker checks t.done every pass, which covers
      // both cases without a separate listener.
      this.reporters.set(publicId, { onProgress, doneReported: false });
      this._startTicker();

      // Persist modtimes so the next launch can skip re-hashing this torrent.
      if (t.done) this._writeCachedModtimes(t, publicId);
      else t.once('done', () => this._writeCachedModtimes(t, publicId));
    });
  }

  // -- adding --------------------------------------------------------------

  add(magnetUri, onTorrentReady, onProgress, onError) {
    if (!this.client) return Promise.reject(new Error('Torrent service not started'));

    const publicId = infoHashFromMagnet(magnetUri);

    // Prefer cached metadata — it makes the file list available immediately and
    // offline. `.local.torrent` is one we generated from the user's own files
    // when the swarm was unreachable; it describes the same content under a
    // different infohash, so it needs the alias.
    const exact = this._readCachedMetadata(publicId, false);
    const local = exact ? null : this._readCachedMetadata(publicId, true);
    const source = exact || local || magnetUri;

    // webtorrent concatenates opts.announce onto whatever the magnet already
    // carries and dedupes the result, so this augments rather than replaces.
    const opts = this._addOpts({ local: !!local, publicId });

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
          Object.assign(this._addOpts({ local: true, publicId }), { path: path.dirname(folderPath) }),
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
   * Order the download so playback comes first — without narrowing what gets
   * downloaded at all.
   *
   * The previous version tried to restrict downloading to the current and next
   * tracks. That never worked and could not have: webtorrent selects the whole
   * torrent at priority 0 the moment metadata arrives, and a per-file deselect
   * cannot match that range. It also leaked — `file.select(1)` pairs with a
   * `file.deselect()` hardcoded to priority 0, and `torrent.deselect` only
   * splices an entry whose priority matches exactly, so every play, seek and
   * shuffle pushed another permanent duplicate into `torrent._selections`.
   *
   * Restricting would have been the wrong goal anyway. Two files out of an
   * album is a request window of a few dozen pieces; with a hundred peers most
   * wires would have nothing to ask for. Breadth is what makes a swarm fast.
   * So: download everything, and layer priorities on top as a diff against
   * tracked state, which is what makes the deselects actually land.
   */
  setPlaybackPriorities(torrentId, currentFileIndex, nextFileIndex, pinnedIndices) {
    const torrent = this._get(torrentId);
    if (!torrent) return;

    // `_updateSelections` early-returns before metadata, so anything applied now
    // would be silently dropped.
    if (!torrent.ready) {
      const key = torrent.infoHash;
      if (!this.pendingSelections.has(key)) {
        torrent.once('ready', () => {
          const args = this.pendingSelections.get(key);
          this.pendingSelections.delete(key);
          if (args) this.setPlaybackPriorities.apply(this, args);
        });
      }
      this.pendingSelections.set(key, [torrentId, currentFileIndex, nextFileIndex, pinnedIndices]);
      return;
    }
    if (!torrent.files.length) return;

    const desired = new Map();
    const want = (index, priority) => {
      if (index == null || index < 0 || desired.has(index)) return;
      const file = torrent.files[index];
      // Nothing to ask for on an empty or already-complete file.
      if (!file || !file.length || file.progress >= 1) return;
      desired.set(index, { from: file._startPiece, to: file._endPiece, priority });
    };

    // Highest priority first — `want` is first-writer-wins, so a file that is
    // both pinned and playing keeps the pinned priority.
    if (Array.isArray(pinnedIndices)) pinnedIndices.forEach((i) => want(i, PRI_PINNED));
    want(currentFileIndex, PRI_CURRENT);
    want(nextFileIndex, PRI_NEXT);

    const key = torrent.infoHash;
    const previous = this.selectionState.get(key) || new Map();
    const same = (a, b) => a && b && a.from === b.from && a.to === b.to && a.priority === b.priority;

    for (const [index, sel] of previous) {
      if (same(sel, desired.get(index))) continue;
      // The exact stored priority is the whole point: that is what lets
      // torrent.deselect find and splice the entry we added.
      try {
        torrent.deselect(sel.from, sel.to, sel.priority);
      } catch (_) {
        /* torrent destroyed mid-update, or webtorrent already GC'd it */
      }
    }
    for (const [index, sel] of desired) {
      if (same(sel, previous.get(index))) continue;
      try {
        torrent.select(sel.from, sel.to, sel.priority);
      } catch (_) {
        /* as above */
      }
    }

    this.selectionState.set(key, desired);
  }

  /**
   * Everything needed to answer "am I bottlenecked, and by what". The peer
   * transport breakdown is the load-bearing part: `inbound > 0` is the only
   * trustworthy proof that port forwarding works, since plenty of routers
   * acknowledge a UPnP mapping they never actually install.
   */
  /** Inbound peers right now across every torrent, and the running peak. */
  _sampleInbound() {
    if (!this.client) return 0;
    let now = 0;
    for (const t of this.client.torrents) {
      for (const wire of t.wires || []) {
        if (/Incoming$/.test(wire.type || '')) now++;
      }
    }
    if (now > this.inboundPeak) this.inboundPeak = now;
    return now;
  }

  getDiagnostics(torrentId) {
    if (!this.client) return null;
    const client = this.client;
    const inboundNow = this._sampleInbound();

    let dhtNodes = 0;
    try {
      if (client.dht && client.dht.nodes) dhtNodes = client.dht.nodes.toArray().length;
    } catch (_) {
      /* dht not up yet */
    }

    const out = {
      client: {
        torrentPort: this.torrentPort,
        dhtPort: this.dhtPort,
        listening: !!client.listening,
        utp: !!client.utp,
        maxConns: client.maxConns,
        downloadSpeed: client.downloadSpeed,
        uploadSpeed: client.uploadSpeed,
        dhtNodes,
        secure: !!this.secure,
        baseline: BASELINE,
      },
      trackers: this.trackers ? this.trackers.status() : null,
      clientError: this.clientError || null,
      clientDestroyed: !!client.destroyed,
      inboundNow,
      inboundPeak: this.inboundPeak,
      torrent: null,
    };

    const t = torrentId ? this._get(torrentId) : null;
    if (!t) return out;

    const peers = {
      total: 0, seeds: 0, leechers: 0, inbound: 0,
      tcpIn: 0, tcpOut: 0, utpIn: 0, utpOut: 0, webSeed: 0,
      unchokedByPeer: 0, interestedInUs: 0,
      encrypted: 0, encryptable: 0,
    };
    for (const wire of t.wires || []) {
      const type = wire.type || '';
      peers.total++;
      if (wire.isSeeder) peers.seeds++;
      else peers.leechers++;
      if (/Incoming$/.test(type)) peers.inbound++;
      if (type === 'tcpIncoming') peers.tcpIn++;
      else if (type === 'tcpOutgoing') peers.tcpOut++;
      else if (type === 'utpIncoming') peers.utpIn++;
      else if (type === 'utpOutgoing') peers.utpOut++;
      else if (type === 'webSeed') peers.webSeed++;
      if (!wire.peerChoking) peers.unchokedByPeer++;
      if (wire.peerInterested) peers.interestedInUs++;

      // `_encryptionMethod`: 2 is RC4, 1 is plaintext-negotiated, null means the
      // wire never ran a PE handshake. Reported against `encryptable` rather
      // than `total`, because uTP and web-seed wires can never be encrypted and
      // counting them in the denominator would make a working setting look broken.
      //
      // Deliberately not also requiring `_cryptoHandshakeDone`: that flag is only
      // set on the _onPe4 path, i.e. the initiating side, so it would undercount
      // every incoming encrypted wire.
      if (type === 'tcpIncoming' || type === 'tcpOutgoing') {
        peers.encryptable++;
        if (wire._encryptionMethod === 2) peers.encrypted++;
      }
    }

    out.torrent = {
      id: torrentId,
      name: t.name,
      ready: !!t.ready,
      done: !!t.done,
      strategy: t.strategy,
      progress: t.progress,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      numPeers: t.numPeers,
      peers,
      // Regression canary for the selection diff: bounded by pinned + current
      // + next + whatever FileStream holds. If this climbs, deselect broke again.
      selections: Array.isArray(t._selections) ? t._selections.length : null,
      pieces: t.pieces
        ? { total: t.pieces.length, missing: t.pieces.reduce((n, p) => n + (p ? 1 : 0), 0) }
        : null,
    };
    return out;
  }

  /**
   * Everything main/swarm-probe.js needs to interrogate a swarm independently.
   * The torrent's own announce list is used rather than the default one — the
   * question is about *this* swarm, and its trackers are the ones that know it.
   */
  getSwarmProbeInput(torrentId) {
    const t = this._get(torrentId);
    if (!t || !t.infoHash) return null;
    const announce = (t.announce || []).slice();
    if (this.trackers) {
      this.trackers.list().forEach((url) => {
        if (announce.indexOf(url) === -1) announce.push(url);
      });
    }
    const knownPeers = (t.wires || [])
      .filter((w) => w.remoteAddress && w.remotePort)
      .map((w) => ({ host: w.remoteAddress, port: w.remotePort }));
    return { infoHash: t.infoHash, trackers: announce, knownPeers };
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
    this.selectionState.delete(real);
    this.pendingSelections.delete(real);
    this.reporters.delete(torrentId);
    this.fileProgressCache.delete(torrentId);
    if (this.activeTorrentId === torrentId) this.activeTorrentId = null;
    await this.client.remove(real, { destroyStore });
  }

  destroy() {
    clearInterval(this.ticker);
    this.ticker = null;
    this.reporters.clear();
    this.fileProgressCache.clear();
    this.torrentServers.forEach((server) => {
      try {
        server.close();
      } catch (_) {}
    });
    this.torrentServers.clear();
    this.torrentServerUrls.clear();
    this.selectionState.clear();
    this.pendingSelections.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

module.exports = { TorrentService, DEFAULT_DOWNLOAD_PATH, infoHashFromMagnet, AUDIO_RE };
