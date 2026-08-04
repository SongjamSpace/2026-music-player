'use strict';

/**
 * Builds index records from the cached .torrent files and what is on disk.
 *
 * This is how the library gets into main/library.js without a WebTorrent client:
 * every album already has its metadata cached at
 * `<userData>/torrents/<infohash>.torrent` (that cache is what makes a finished
 * album openable when its swarm is dead), and the files themselves are on disk. So
 * the whole index can be reconstructed from a directory listing and some stats —
 * no network, no peers, no piece verification.
 *
 * That matters beyond the one-time migration: it is also the answer to "what does
 * the UI render before any torrent is live", which is the entire point of the
 * index.
 *
 * What this deliberately does *not* do is verify content. A stat tells us a file
 * exists at the expected length; it does not tell us the bytes are right. So
 * `verified` here means "present and correctly sized", and anything that needs
 * stronger proof — seeding, say — has to go through webtorrent's own verification.
 * Playback is the case this is for, and a truncated or replaced file surfaces
 * immediately as a decode error rather than silently wrong audio.
 */

const fsp = require('fs/promises');
const path = require('path');
const parseTorrent = require('parse-torrent');

/** Bounded concurrency, because the library lives on one external spindle. */
const STAT_CONCURRENCY = 8;

/**
 * Pull the 40-hex infohash out of a magnet URI.
 * Duplicated from torrent-service rather than imported, so this module stays free
 * of any dependency on webtorrent.
 */
function infoHashFromMagnet(magnetUri) {
  const match = /xt=urn:btih:([a-fA-F0-9]{40})/.exec(magnetUri || '');
  return match ? match[1].toLowerCase() : null;
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.cacheDir  Where `<infohash>.torrent` files live.
 * @param {string} opts.publicId  The library id — the magnet's infohash, which can
 *   differ from the cached torrent's own hash when the album was seeded from disk.
 * @param {string} opts.downloadRoot
 * @param {string=} opts.magnetURI
 * @returns {Promise<object|null>} an index record, or null if there is no usable
 *   cached metadata for this id.
 */
async function buildRecord({ cacheDir, publicId, downloadRoot, magnetURI }) {
  // `.local.torrent` describes the same content under a different infohash — it is
  // generated when the swarm is dead and we re-hash the user's own files — so it is
  // just as good a source for a file list, and its hash is worth keeping.
  const candidates = [
    { file: path.join(cacheDir, publicId + '.torrent'), local: false },
    { file: path.join(cacheDir, publicId + '.local.torrent'), local: true },
  ];

  let parsed = null;
  let local = false;
  for (const candidate of candidates) {
    let buf;
    try {
      buf = await fsp.readFile(candidate.file);
    } catch (_) {
      continue;
    }
    try {
      parsed = await parseTorrent(buf);
      local = candidate.local;
      break;
    } catch (err) {
      console.warn('[library-import] unreadable metadata for', publicId, '-', err.message);
    }
  }
  if (!parsed || !Array.isArray(parsed.files)) return null;

  // webtorrent writes into `<downloadRoot>/<torrent name>/…`, and parse-torrent's
  // `file.path` already includes that leading name segment — so the root really is
  // the download root, not the album folder.
  const root = downloadRoot;

  const stats = await mapLimited(parsed.files, STAT_CONCURRENCY, async (file) => {
    try {
      const st = await fsp.stat(path.join(root, file.path));
      return { exists: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
    } catch (_) {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
  });

  let presentBytes = 0;
  const tracks = parsed.files.map((file, i) => {
    const st = stats[i];
    // Sparse preallocation means a partial file can already be full-length, so
    // size alone is not proof — but a *wrong* size is proof of the negative, which
    // is the direction that matters for deciding whether to serve it.
    //
    // The gap this leaves is real and has been hit: a file of exactly the right
    // length whose bytes were never written plays until the damaged region and then
    // dies, and the player cannot tell that from a format it does not support. Only
    // the torrent's piece hashes can, and hashing 6 GB off USB on import is exactly
    // the boot cost this design exists to avoid. So the import stays optimistic and
    // `repair-track` in main/index.js is the way out: it clears this flag and lets
    // webtorrent re-hash that one album on demand.
    const verified = st.exists && st.size === file.length;
    if (verified) presentBytes += file.length;
    return {
      i: i,
      path: file.path,
      name: file.name,
      length: file.length,
      verified: verified,
      mtimeMs: st.mtimeMs || null,
    };
  });

  const totalBytes = parsed.files.reduce((n, f) => n + (f.length || 0), 0);
  const complete = tracks.length > 0 && tracks.every((t) => t.verified);

  // Only meaningful when it differs from the library id: that is what says the
  // album was re-hashed from local files and the swarm knows it by another hash.
  const parsedHash = String(parsed.infoHash || '').toLowerCase();
  const aliasHash = local && parsedHash && parsedHash !== publicId ? parsedHash : null;

  return {
    id: publicId,
    realInfoHash: aliasHash,
    magnetURI: magnetURI || null,
    name: parsed.name || publicId,
    root: root,
    // `archived` asserts we hold cached metadata and could wake instantly and
    // offline. Without every file present it is only `idle`.
    state: complete ? 'archived' : 'idle',
    totalBytes: totalBytes,
    presentBytes: presentBytes,
    pieceLength: parsed.pieceLength || 0,
    numPieces: (parsed.pieces || []).length,
    complete: complete,
    tracks: tracks,
    art: { status: 'pending' },
    importedAt: null, // stamped by the caller, which owns the clock
  };
}

/**
 * Populate the index from the saved magnet list.
 *
 * Idempotent and additive: albums already in the index are skipped, so this can run
 * on every launch and is safe to re-run after a partial failure. It never deletes.
 *
 * @returns {Promise<{added: number, skipped: number, unresolved: string[]}>}
 */
async function importFromMagnets({ library, magnets, cacheDir, downloadRoot, now }) {
  const result = { added: 0, skipped: 0, unresolved: [] };
  if (!Array.isArray(magnets) || !magnets.length) return result;

  for (const magnetURI of magnets) {
    const publicId = infoHashFromMagnet(magnetURI);
    if (!publicId) {
      // base32 or malformed — nothing to key an index record on.
      result.unresolved.push(magnetURI.slice(0, 60));
      continue;
    }
    if (library.has(publicId)) {
      result.skipped++;
      continue;
    }
    let record;
    try {
      record = await buildRecord({ cacheDir, publicId, downloadRoot, magnetURI });
    } catch (err) {
      console.warn('[library-import] failed for', publicId, '-', err.message);
      record = null;
    }
    if (!record) {
      // No cached metadata: the album was added but never got a file list from a
      // peer. It stays in `magnets` and will be imported once metadata arrives.
      result.unresolved.push(publicId);
      continue;
    }
    record.importedAt = now || null;
    await library.upsert(record);
    result.added++;
  }

  return result;
}

module.exports = { importFromMagnets, buildRecord, infoHashFromMagnet };
