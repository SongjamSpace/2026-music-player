#!/usr/bin/env node
'use strict';

/**
 * Prices the torrent engine's piece caches against the real library.
 *
 * `storeCacheSlots` looks like a harmless integer and is not: it is the `max` of
 * an LRU of *whole pieces* (webtorrent/lib/torrent.js:494-497 wraps the store in
 * cache-chunk-store, whose chunkLength is the piece length). So the resident
 * ceiling is `slots × pieceLength` per torrent, and the number is invisible in
 * code review — you cannot tell 64 is expensive without knowing the piece
 * lengths of the torrents you actually have.
 *
 * This is the check that would have caught it. It reads the cached .torrent
 * files, so it needs no network, no download and no running app.
 *
 *   node scripts/library-cost-check.js
 *   node scripts/library-cost-check.js --json
 *   node scripts/library-cost-check.js --slots 64   # price a hypothetical
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const parseTorrent = require('parse-torrent');
const tuning = require('../main/tuning');

const CACHE = path.join(os.homedir(), 'Library/Application Support/2026-music-player/torrents');

/**
 * Total predicted piece-cache bytes across the whole library.
 *
 * This is a deliberately pessimistic bound — it assumes every torrent is live
 * with a full cache at once, which after the lifecycle manager lands is no
 * longer true. It stays useful precisely because it is the number that grows
 * silently as the library grows: if this passes, no amount of added music can
 * make the piece caches the problem.
 */
const BUDGET_BYTES = 256 * 1024 * 1024;

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Whole-piece LRU ceiling for a fixed slot count, for --slots comparisons. */
function bytesAtSlots(slots, pieceLength, numPieces) {
  const usable = numPieces > 0 ? Math.min(slots, numPieces) : slots;
  return usable * pieceLength;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const slotsArgIndex = process.argv.indexOf('--slots');
  const forcedSlots = slotsArgIndex > -1 ? Number(process.argv[slotsArgIndex + 1]) : null;

  let files;
  try {
    files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.torrent'));
  } catch (err) {
    console.error('No cached torrents at ' + CACHE + ' — open the app once first.');
    process.exit(2);
  }

  const rows = [];
  const readerMismatches = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(CACHE, f));
    const parsed = await parseTorrent(buf);
    const pieceLength = parsed.pieceLength || 0;
    const numPieces = (parsed.pieces || []).length;

    // The runtime cannot afford parse-torrent (async in the version webtorrent
    // 1.9.7 pins) at `client.add()` time, so it reads the piece length straight
    // out of the bencoded buffer. This is where that shortcut gets checked
    // against the real parser, over the real library.
    const shortcut = tuning.pieceLengthFromTorrentFile(buf);
    if (shortcut !== pieceLength) {
      readerMismatches.push({ name: parsed.name || f, shortcut: shortcut, actual: pieceLength });
    }

    rows.push({
      name: parsed.name || f,
      pieceLength: pieceLength,
      numPieces: numPieces,
      slots: forcedSlots != null ? forcedSlots : tuning.storeCacheSlots(pieceLength),
      bytes:
        forcedSlots != null
          ? bytesAtSlots(forcedSlots, pieceLength, numPieces)
          : tuning.storeCacheBytes(pieceLength, numPieces),
    });
  }

  rows.sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const over = total > BUDGET_BYTES || readerMismatches.length > 0;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          rows: rows,
          totalBytes: total,
          budgetBytes: BUDGET_BYTES,
          readerMismatches: readerMismatches,
          ok: !over,
        },
        null,
        2
      )
    );
    process.exit(over ? 1 : 0);
  }

  console.log('');
  console.log(
    '  ' +
      'piece'.padStart(8) +
      'pieces'.padStart(9) +
      'slots'.padStart(7) +
      'cache'.padStart(10) +
      '  torrent'
  );
  for (const r of rows) {
    console.log(
      '  ' +
        (mb(r.pieceLength) + 'M').padStart(8) +
        String(r.numPieces).padStart(9) +
        String(r.slots).padStart(7) +
        (mb(r.bytes) + 'M').padStart(10) +
        '  ' +
        r.name.slice(0, 44)
    );
  }
  console.log('');
  for (const m of readerMismatches) {
    console.log(
      '  FAIL  pieceLengthFromTorrentFile read ' +
        m.shortcut +
        ' but parse-torrent says ' +
        m.actual +
        ' for ' +
        m.name.slice(0, 40)
    );
  }
  console.log(
    '  ' +
      (over ? 'FAIL  ' : 'PASS  ') +
      rows.length +
      ' torrents, worst-case piece cache ' +
      mb(total) +
      ' MB' +
      (forcedSlots != null ? ' at a forced ' + forcedSlots + ' slots' : '') +
      ' (budget ' +
      mb(BUDGET_BYTES) +
      ' MB)'
  );
  console.log('');
  process.exit(over ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
