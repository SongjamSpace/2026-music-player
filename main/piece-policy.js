/**
 * Piece-level download policy: what to ask peers for, and in what order.
 *
 * Two jobs, both driven off a single 1 Hz tick so they can share the play-head
 * calculation and never fight each other:
 *
 *   1. Strategy. WebTorrent defaults to `sequential`, which is bad for swarm
 *      throughput — every sequential client races for the same low-index
 *      pieces, so you end up holding pieces nobody wants, nobody reciprocates,
 *      and you get choked. Rarest-first is what earns unchokes. But rarest-first
 *      while the buffer is thin means stalls. So: sequential when the play head
 *      is exposed, rarest once it is comfortably ahead, with a wide hysteresis
 *      band so it can't flap.
 *
 *   2. Readahead. WebTorrent's own FileStream marks at most 2 pieces critical
 *      ahead of the read head (`_criticalLength`), which at a typical piece
 *      length is on the order of ten seconds of audio. Any dip in speed becomes
 *      audible. This widens that to a real 30-second window.
 *
 * Both are deliberately advisory: the priority selections in torrent-service
 * decide *what* is wanted, this decides *what first*. Nothing here ever narrows
 * the download to a subset of the torrent.
 */

const TICK_MS = 1000;

// Hysteresis band. Below the floor the play head is exposed and sequential is
// the safer read; above the ceiling there is enough runway to spend on being a
// useful swarm member. The gap between them is what stops it oscillating.
const SEQUENTIAL_BELOW_S = 15;
const RAREST_ABOVE_S = 45;

const READAHEAD_TARGET_S = 30;
const READAHEAD_MIN_PIECES = 4; // never worse than webtorrent's own 2
const READAHEAD_MAX_PIECES = 64; // a long FLAC must not mark half the album critical

// Enough runway to measure well past RAREST_ABOVE_S without walking a whole
// large torrent's bitfield every second.
const BUFFER_SCAN_LIMIT = 512;

const NEXT_TRACK_PREFETCH_AFTER = 0.6; // fraction of the current track downloaded
const NEXT_TRACK_PREFETCH_S = 5; // enough for a gapless handover

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {object} deps
 * @param {import('./torrent-service').TorrentService} deps.service
 * @param {function(): object} deps.getPrefs
 */
function createPiecePolicy({ service, getPrefs }) {
  let timer = null;
  let playback = null; // { torrentId, fileIndex, nextFileIndex, currentTime, duration }
  let last = { strategy: null, headPiece: null, readahead: null, secondsBuffered: null };
  // The critical window we last applied, so an unmoved play head costs nothing.
  let lastWindow = { key: null, ranges: '' };

  /**
   * A torrent this tick is allowed to touch.
   *
   * `select`, `deselect` and `critical` all throw outright on a destroyed
   * torrent (lib/torrent.js:972, :995, :1012), and a torrent can be removed
   * between one tick and the next — the user pressing Remove is enough. An
   * unguarded throw in a setInterval callback takes the whole main process
   * down, so nothing here dereferences a torrent without passing this first.
   */
  function usable(torrent) {
    return !!(torrent && !torrent.destroyed && torrent.ready && torrent.bitfield);
  }

  /** How many contiguous pieces we already hold starting at the play head. */
  function contiguousFrom(torrent, startPiece, lastPiece) {
    const limit = Math.min(lastPiece, startPiece + BUFFER_SCAN_LIMIT);
    let n = 0;
    for (let i = startPiece; i <= limit; i++) {
      if (!torrent.bitfield.get(i)) break;
      n++;
    }
    return n;
  }

  /**
   * WebTorrent sets `_critical[i] = true` and never sets it back — there is no
   * expiry and no cap. Critical pieces skip the peer speed ranking *and* ignore
   * block reservations, so every stale entry is a standing invitation to
   * request the same block from several peers at once. Left alone the set grows
   * monotonically for the life of the torrent and quietly burns bandwidth.
   *
   * @param {Array<Array<number>>} keep  Inclusive [from, to] ranges to preserve.
   */
  function collectCritical(torrent, keep) {
    const critical = torrent._critical;
    if (!Array.isArray(critical)) return;
    const inKeep = (i) => keep.some(([from, to]) => i >= from && i <= to);
    for (let i = 0; i < critical.length; i++) {
      if (critical[i] && !inKeep(i)) critical[i] = false;
    }
  }

  function applyStrategy(torrent, wanted) {
    if (torrent.strategy === wanted) return;
    torrent.strategy = wanted;
  }

  function tick() {
    const client = service.client;
    if (!client) return;

    const prefs = getPrefs();
    const mode = prefs.pieceStrategy || 'auto';
    const active = playback && playback.torrentId ? service._get(playback.torrentId) : null;

    // Background torrents have no play head to protect, so rarest-first is
    // unambiguously right for them.
    for (const torrent of client.torrents) {
      if (torrent === active || !usable(torrent)) continue;
      applyStrategy(torrent, mode === 'auto' ? 'rarest' : mode);
    }

    if (!usable(active) || active.done) return;

    const file = active.files[playback.fileIndex];
    const duration = playback.duration;
    if (!file || !file.length || !duration || !isFinite(duration)) {
      // Without a duration there is no time→byte mapping, so leave webtorrent's
      // own FileStream criticality to it rather than guessing at an offset.
      if (mode !== 'auto') applyStrategy(active, mode);
      return;
    }

    const pieceLength = active.pieceLength;
    const played = clamp(playback.currentTime / duration, 0, 1) * file.length;
    const headPiece = clamp(
      Math.floor((file.offset + played) / pieceLength),
      file._startPiece,
      file._endPiece
    );

    // Real average bitrate straight from the file — no tag parsing, and it is
    // the number that actually governs how fast the play head consumes bytes.
    const bytesPerSecond = file.length / duration;
    const buffered = contiguousFrom(active, headPiece, file._endPiece);
    const secondsBuffered = (buffered * pieceLength) / bytesPerSecond;

    // -- strategy ----------------------------------------------------------
    if (mode === 'sequential' || mode === 'rarest') {
      applyStrategy(active, mode);
    } else if (secondsBuffered < SEQUENTIAL_BELOW_S) {
      applyStrategy(active, 'sequential');
    } else if (secondsBuffered > RAREST_ABOVE_S) {
      applyStrategy(active, 'rarest');
    } // in between: leave whatever it is — that gap is the hysteresis

    // -- readahead ---------------------------------------------------------
    const readahead = clamp(
      Math.ceil((READAHEAD_TARGET_S * bytesPerSecond) / pieceLength),
      READAHEAD_MIN_PIECES,
      READAHEAD_MAX_PIECES
    );
    const readaheadEnd = Math.min(headPiece + readahead, file._endPiece);
    const keep = [[headPiece, readaheadEnd]];

    // Once the current track is mostly in hand, pull the head of the next one
    // so the handover doesn't stall on a cold start.
    if (prefs.prefetch !== false && file.progress >= NEXT_TRACK_PREFETCH_AFTER) {
      const nextFile = active.files[playback.nextFileIndex];
      if (nextFile && nextFile.length && nextFile !== file && nextFile.progress < 1) {
        const span = clamp(
          Math.ceil((NEXT_TRACK_PREFETCH_S * (nextFile.length / duration)) / pieceLength),
          1,
          READAHEAD_MIN_PIECES
        );
        keep.push([nextFile._startPiece, Math.min(nextFile._startPiece + span, nextFile._endPiece)]);
      }
    }

    // `critical()` re-runs the full selection update, which walks every piece
    // against every wire — at 120 peers that is not something to do once a
    // second for no reason. The flags are sticky, so re-applying an unchanged
    // window would be pure cost.
    const key = active.infoHash;
    const signature = keep.map((r) => r.join('-')).join(',');
    if (lastWindow.key !== key || lastWindow.ranges !== signature) {
      keep.forEach(([from, to]) => active.critical(from, to));
      collectCritical(active, keep);
      lastWindow = { key, ranges: signature };
    }

    last = { strategy: active.strategy, headPiece, readahead, secondsBuffered };
  }

  /**
   * This is advisory optimisation, not correctness — downloads work without it,
   * just less smoothly. So a bad tick must never be fatal: an uncaught throw
   * inside a setInterval callback ends the main process, taking playback and
   * every torrent with it, over what is at worst a dropped readahead update.
   */
  function safeTick() {
    try {
      tick();
    } catch (err) {
      console.error('[piece-policy] tick failed:', (err && err.message) || err);
    }
  }

  return {
    start() {
      if (timer) return;
      // unref so this tick can never be the reason the process stays alive.
      timer = setInterval(safeTick, TICK_MS);
      if (timer.unref) timer.unref();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    /** @param {object|null} state  null when playback stops. */
    setPlaybackState(state) {
      playback = state;
    },

    status: () => Object.assign({}, last),
  };
}

module.exports = { createPiecePolicy };
