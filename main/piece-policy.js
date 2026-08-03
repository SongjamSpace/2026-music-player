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
 *      With one hard limit on top: rarest is only ever applied to torrents small
 *      enough that webtorrent's rarity scan is cheap. It is O(all pieces) per
 *      call inside a loop over the selection span, so on a 5,847-piece
 *      discography it dominated the main thread and stalled the event loop for
 *      over a second at a time. See tuning.rarestIsAffordable for the profile.
 *      This is why `applyStrategy` is the only place strategy is assigned.
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

const tuning = require('./tuning');

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
  let lastWindow = { key: null, ranges: '', headPiece: null };
  // Piece indices this module marked critical, so they can be retracted without
  // walking — or disturbing — the rest of the torrent's flags.
  let ourCritical = new Set();

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
   * Clears only what *we* marked, tracked in `ourCritical`, rather than sweeping
   * the whole array. The sweep was O(total pieces in the torrent) with a closure
   * call per piece — 5,847 pieces for the largest album here, every time the
   * window moved — to clear at most a few dozen flags we had set ourselves.
   * WebTorrent's own FileStream criticality is deliberately left alone: it is
   * not ours to clear, and clearing it was never the point.
   *
   * @param {Array<Array<number>>} keep  Inclusive [from, to] ranges to preserve.
   */
  function collectCritical(torrent, keep) {
    const critical = torrent._critical;
    if (!Array.isArray(critical)) return;
    for (const i of ourCritical) {
      let inKeep = false;
      for (let k = 0; k < keep.length; k++) {
        if (i >= keep[k][0] && i <= keep[k][1]) {
          inKeep = true;
          break;
        }
      }
      if (!inKeep) {
        critical[i] = false;
        ourCritical.delete(i);
      }
    }
  }

  /** Remember a range as ours, so collectCritical can retract exactly it later. */
  function markOurs(from, to) {
    for (let i = from; i <= to; i++) ourCritical.add(i);
  }

  // -- monotonic progress memos --------------------------------------------
  //
  // `file.progress` is a getter over `file.downloaded`, which loops every piece
  // of the file and allocates two closures per call (webtorrent/lib/file.js
  // :42-84). This tick asked for two of them every second, forever, to answer
  // two questions whose answers can only ever flip one way: "is the current
  // track 60% in hand" and "is the next track finished". So once either is true
  // it is remembered and never recomputed.

  /** infoHash + ':' + fileIndex for whichever answers have already latched. */
  const prefetchReached = new Set();
  const filesComplete = new Set();

  function memoKey(torrent, fileIndex) {
    return torrent.infoHash + ':' + fileIndex;
  }

  function reachedPrefetchPoint(torrent, fileIndex, file) {
    const key = memoKey(torrent, fileIndex);
    if (prefetchReached.has(key)) return true;
    if (file.progress >= NEXT_TRACK_PREFETCH_AFTER) {
      prefetchReached.add(key);
      return true;
    }
    return false;
  }

  function isFileComplete(torrent, fileIndex, file) {
    const key = memoKey(torrent, fileIndex);
    if (filesComplete.has(key)) return true;
    if (file.progress >= 1) {
      filesComplete.add(key);
      return true;
    }
    return false;
  }

  /**
   * @param {string} wanted  'rarest' or 'sequential'.
   *
   * Rarest is downgraded to sequential on any torrent big enough for webtorrent's
   * O(pieces) rarity scan to matter — see tuning.rarestIsAffordable, which carries
   * the profile that justifies the bound. This is the only place that decision is
   * made, so it covers the active torrent and background ones alike.
   */
  function applyStrategy(torrent, wanted) {
    var effective = wanted === 'rarest' && !tuning.rarestIsAffordable(torrent) ? 'sequential' : wanted;
    if (torrent.strategy === effective) return;
    torrent.strategy = effective;
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
    if (prefs.prefetch !== false && reachedPrefetchPoint(active, playback.fileIndex, file)) {
      const nextFile = active.files[playback.nextFileIndex];
      if (
        nextFile &&
        nextFile.length &&
        nextFile !== file &&
        !isFileComplete(active, playback.nextFileIndex, nextFile)
      ) {
        const span = clamp(
          Math.ceil((NEXT_TRACK_PREFETCH_S * (nextFile.length / duration)) / pieceLength),
          1,
          READAHEAD_MIN_PIECES
        );
        keep.push([nextFile._startPiece, Math.min(nextFile._startPiece + span, nextFile._endPiece)]);
      }
    }

    // `critical()` re-runs the full selection update, which walks every piece
    // against every wire — at 60 peers that is not something to do once a second
    // for no reason. The flags are sticky, so re-applying an unchanged window
    // would be pure cost.
    //
    // The signature guard alone was not enough: the play head advances every
    // tick, so `headPiece` — and therefore the signature — changed on every
    // single pass and the guard never once held. Re-applying only when the head
    // has moved at least half the readahead window keeps the buffer covered (the
    // window is `readahead` pieces deep, so half of it is still ahead of the
    // head when we refresh) while cutting the work to roughly one pass in
    // `readahead/2` ticks.
    const key = active.infoHash;
    const sameTorrent = lastWindow.key === key;
    const drift = sameTorrent && lastWindow.headPiece != null
      ? headPiece - lastWindow.headPiece
      : Infinity;

    // Only the ranges *past* the readahead window — i.e. the next-track prefetch.
    // Signing the whole of `keep` would be useless here: the first range starts
    // at `headPiece`, so its signature changes on every tick and any guard built
    // on it can never hold. Drift covers that range; this covers the rest.
    const signature = keep.slice(1).map((r) => r.join('-')).join(',');

    // Backwards is a seek, not drift: honour it immediately, or the listener
    // waits on a window still sitting ahead of wherever they jumped from.
    const seeked = drift < 0;
    const advanced = drift >= Math.max(1, Math.floor(readahead / 2));
    const prefetchChanged = lastWindow.ranges !== signature;

    if (!sameTorrent) ourCritical = new Set();

    if (!sameTorrent || seeked || advanced || prefetchChanged) {
      keep.forEach(([from, to]) => {
        active.critical(from, to);
        markOurs(from, to);
      });
      collectCritical(active, keep);
      lastWindow = { key, ranges: signature, headPiece };
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
      ourCritical = new Set();
      prefetchReached.clear();
      filesComplete.clear();
      lastWindow = { key: null, ranges: '', headPiece: null };
    },

    /**
     * Drop memoised state for a torrent that is going away.
     *
     * These sets are keyed by infoHash and would otherwise be the one thing here
     * that grows for the life of the process — small per entry, but unbounded
     * across a library that gets added to, which is exactly the shape of leak
     * this whole pass is about.
     */
    forget(infoHash) {
      if (!infoHash) return;
      const prefix = infoHash + ':';
      for (const key of prefetchReached) if (key.startsWith(prefix)) prefetchReached.delete(key);
      for (const key of filesComplete) if (key.startsWith(prefix)) filesComplete.delete(key);
      if (lastWindow.key === infoHash) {
        lastWindow = { key: null, ranges: '', headPiece: null };
        ourCritical = new Set();
      }
    },

    /** @param {object|null} state  null when playback stops. */
    setPlaybackState(state) {
      playback = state;
    },

    status: () => Object.assign({}, last),
  };
}

module.exports = { createPiecePolicy };
