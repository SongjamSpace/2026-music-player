'use strict';

/**
 * Torrent engine tuning that has a measurable memory cost, kept in a module of
 * its own so `scripts/library-cost-check.js` can compute the real footprint
 * without loading webtorrent (and therefore utp-native) in a plain node script.
 *
 * Nothing here may require anything. It is pure arithmetic over torrent
 * metadata, and both the runtime and the check harness depend on it agreeing.
 */

/**
 * Per torrent, not client-wide: webtorrent's `_drain()` compares each torrent's
 * own connection count against `client.maxConns`. The library default of 55
 * binds on any healthy swarm; qBittorrent ships 100 per torrent. Watch for
 * EMFILE with several torrents live and drop this to 40 if it appears.
 *
 * Was 120. Each wire carries its own read/write buffers and a bitfield, so this
 * multiplies by the number of live torrents — which used to be "every torrent
 * in the library".
 */
const MAX_CONNS = 60;

/**
 * Memory budget for one torrent's whole-piece LRU, in bytes.
 *
 * `storeCacheSlots` is not a count of anything small: it is the `max` of an LRU
 * of *whole pieces* (webtorrent/lib/torrent.js:494-497 wraps the store in
 * cache-chunk-store, whose `chunkLength` is the piece length). So the ceiling is
 * `slots × pieceLength`, and a flat slot count prices torrents wildly
 * differently depending on how they were made.
 *
 * Measured on the real library: at the previous flat 64 slots, a 4 MB-piece
 * torrent reserved 256 MB on its own while a 256 KB-piece torrent reserved 16 MB
 * — a 16x spread for no reason anyone chose. Budgeting bytes instead of slots
 * makes the cost per torrent predictable, which is the whole point once several
 * are live.
 */
const STORE_CACHE_BUDGET = 8 * 1024 * 1024;

/** Floor: below this the cache stops absorbing the read pattern it exists for. */
const STORE_CACHE_MIN_SLOTS = 8;
/** Ceiling: a tiny piece length must not turn the budget into 4000 LRU entries. */
const STORE_CACHE_MAX_SLOTS = 32;

/**
 * How many whole-piece slots to give a torrent with this piece length.
 *
 * @param {number} pieceLength  Bytes. Unknown/0 (a magnet before metadata) gets
 *   the floor — it is corrected on 'ready', and guessing high is the expensive
 *   direction.
 * @returns {number}
 */
function storeCacheSlots(pieceLength) {
  if (!pieceLength || !isFinite(pieceLength) || pieceLength <= 0) {
    return STORE_CACHE_MIN_SLOTS;
  }
  const slots = Math.ceil(STORE_CACHE_BUDGET / pieceLength);
  return Math.max(STORE_CACHE_MIN_SLOTS, Math.min(STORE_CACHE_MAX_SLOTS, slots));
}

/**
 * Worst-case bytes that torrent's piece cache can hold.
 *
 * Capped by the piece count, because a torrent with fewer pieces than slots can
 * never fill them — which matters for small torrents, where the naive
 * `slots × pieceLength` overstates the cost.
 *
 * @param {number} pieceLength
 * @param {number} numPieces
 * @returns {number}
 */
function storeCacheBytes(pieceLength, numPieces) {
  const slots = storeCacheSlots(pieceLength);
  const usable = numPieces > 0 ? Math.min(slots, numPieces) : slots;
  return usable * pieceLength;
}

/**
 * Largest torrent, in pieces, that rarest-first picking is affordable on.
 *
 * Rarest-first is the right thing for swarm reciprocation and the wrong thing to
 * ask webtorrent 1.9.7 for on a large torrent, because its implementation is
 * quadratic:
 *
 *   - `rarity-map.js getRarestPiece()` scans *every piece in the torrent* on
 *     every call — there is no index, and the selection range only filters, it
 *     does not bound the scan.
 *   - `torrent.js trySelectWire()`/`validateWire()` call it inside
 *     `while (tries < len)`, where `len` is the selection span. The base
 *     selection covers the whole torrent, so `len` is the piece count.
 *   - the filter it passes invokes `speedRanker()`'s closure, which loops every
 *     wire for each candidate piece.
 *   - `_update()` runs all of that for every wire, and is called from eight
 *     separate wire events (have, bitfield, unchoke, block received, …).
 *
 * Measured on this library with 11 live torrents and 35 wires: a V8 CPU profile
 * of the main process attributed ~14% of wall-clock — and ~85% of all non-idle JS
 * time — to `_updateWire` and those two closures, with event-loop stalls up to
 * 1.4 s. The largest torrent here is 5,847 pieces.
 *
 * Below this bound a full scan is cheap enough not to matter. Above it, sequential
 * is used instead: its branch is a descending loop with an early exit and no
 * rarity scan at all. That trades some swarm-reciprocation quality for an event
 * loop that does not stall — the right trade for an audio player, where a stall is
 * audible.
 */
const RAREST_MAX_PIECES = 1024;

/**
 * Piece length straight out of a bencoded .torrent buffer.
 *
 * Needed because `storeCacheSlots` is captured when the Torrent object is
 * constructed and the store is built inside `_onMetadata` *before* `'metadata'`
 * is emitted (webtorrent/lib/torrent.js:445-534) — so there is no later hook at
 * which to correct it. The value has to be known at `client.add()` time, and the
 * only thing available that early is the cached .torrent file.
 *
 * `parse-torrent` would be the obvious tool and is deliberately not used: in the
 * version webtorrent 1.9.7 depends on it is async, which would make `_addOpts`
 * async and ripple through both add paths for one integer.
 * `scripts/library-cost-check.js` cross-checks this function against
 * `parse-torrent` over the real library, so the shortcut is tested rather than
 * assumed.
 *
 * @param {Buffer} buf  Raw .torrent contents.
 * @returns {number} Piece length in bytes, or 0 if it cannot be read.
 */
function pieceLengthFromTorrentFile(buf) {
  if (!buf || typeof buf.indexOf !== 'function') return 0;
  // Bencoded dict keys are length-prefixed, so this exact byte sequence cannot
  // occur as a substring of a filename or any other string value.
  const at = buf.indexOf('12:piece lengthi');
  if (at === -1) return 0;
  const start = at + '12:piece lengthi'.length;
  const end = buf.indexOf('e', start);
  if (end === -1) return 0;
  const n = Number(buf.toString('latin1', start, end));
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * Whether rarest-first picking is affordable for this torrent.
 *
 * @param {object} torrent  A live webtorrent Torrent.
 * @returns {boolean}
 */
function rarestIsAffordable(torrent) {
  const numPieces = torrent && torrent.pieces ? torrent.pieces.length : 0;
  return numPieces > 0 && numPieces <= RAREST_MAX_PIECES;
}

module.exports = {
  MAX_CONNS,
  RAREST_MAX_PIECES,
  rarestIsAffordable,
  pieceLengthFromTorrentFile,
  STORE_CACHE_BUDGET,
  STORE_CACHE_MIN_SLOTS,
  STORE_CACHE_MAX_SLOTS,
  storeCacheSlots,
  storeCacheBytes,
};
