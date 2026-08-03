#!/usr/bin/env node
'use strict';

/**
 * Checks main/library-import.js against the real library.
 *
 * The import is what reconstructs the whole index from cached .torrent files and
 * disk state, with no WebTorrent client involved — so if it is wrong, the app
 * renders a library that does not match what is on the drive. Running it against
 * the actual cache and the actual external drive is the only way to know it agrees
 * with reality.
 *
 * Read-only: it imports into a throwaway index directory and never touches the real
 * one. Skips cleanly when the drive is not mounted.
 *
 *   node scripts/library-import-check.js
 *   node scripts/library-import-check.js --list
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary } = require('../main/library');
const { importFromMagnets, infoHashFromMagnet } = require('../main/library-import');

const USER_DATA = path.join(os.homedir(), 'Library/Application Support/2026-music-player');
const CACHE = path.join(USER_DATA, 'torrents');
const CONFIG = path.join(USER_DATA, 'config.json');

let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(52) + (detail == null ? '' : detail));
}

function fmtGb(bytes) {
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

async function main() {
  const showAll = process.argv.includes('--list');

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (_) {
    console.error('\n  no config at ' + CONFIG + ' — open the app once first\n');
    process.exit(2);
  }

  const magnets = config.magnets || [];
  const downloadRoot = config.downloadPath;
  if (!downloadRoot || !fs.existsSync(downloadRoot)) {
    console.log(
      '\n  download root not available (' + (downloadRoot || 'unset') + ')' +
        '\n  connect the drive to check the import against real files\n'
    );
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-import-'));
  const library = createLibrary({ dir });
  await library.load();

  const started = Date.now();
  const result = await importFromMagnets({
    library,
    magnets,
    cacheDir: CACHE,
    downloadRoot,
    now: new Date().toISOString(),
  });
  const ms = Date.now() - started;
  await library.flush();

  console.log('');
  console.log('  imported ' + result.added + ' of ' + magnets.length + ' magnets in ' + ms + 'ms');
  if (result.unresolved.length) {
    console.log('  ' + result.unresolved.length + ' without cached metadata (never got a file list)');
  }
  console.log('');

  const albums = library.list().sort((a, b) => b.totalBytes - a.totalBytes);
  for (const a of albums) {
    const present = a.tracks.filter((t) => t.verified).length;
    console.log(
      '    ' + (a.complete ? 'complete ' : 'partial  ') +
        String(present).padStart(4) + '/' + String(a.tracks.length).padEnd(5) +
        fmtGb(a.presentBytes).padStart(9) + ' of ' + fmtGb(a.totalBytes).padEnd(9) + '  ' +
        a.name.slice(0, 38)
    );
    if (showAll) {
      a.tracks.slice(0, 5).forEach((t) =>
        console.log('        ' + (t.verified ? '·' : '×') + ' ' + t.path.slice(0, 70))
      );
    }
  }
  console.log('');

  // -- assertions ----------------------------------------------------------
  check('every magnet with cached metadata imported',
    result.added + result.skipped + result.unresolved.length === magnets.length,
    result.added + '+' + result.skipped + '+' + result.unresolved.length + ' of ' + magnets.length);
  check('at least one album imported', albums.length > 0, albums.length + ' albums');
  check('every album has an id matching its magnet',
    albums.every((a) => a.id === infoHashFromMagnet(a.magnetURI)));
  check('every album has tracks', albums.every((a) => a.tracks.length > 0));
  check('every track carries a torrent-relative path',
    albums.every((a) => a.tracks.every((t) => t.path && !path.isAbsolute(t.path))));
  check('track indices are 0..n-1 in order',
    albums.every((a) => a.tracks.every((t, i) => t.i === i)));
  check('piece length known for every album', albums.every((a) => a.pieceLength > 0));
  check('complete albums have every track verified',
    albums.filter((a) => a.complete).every((a) => a.tracks.every((t) => t.verified)));
  check('partial albums have at least one unverified track',
    albums.filter((a) => !a.complete).every((a) => a.tracks.some((t) => !t.verified)));
  check('presentBytes never exceeds totalBytes',
    albums.every((a) => a.presentBytes <= a.totalBytes));
  check('complete albums have presentBytes === totalBytes',
    albums.filter((a) => a.complete).every((a) => a.presentBytes === a.totalBytes));
  check('state is archived exactly when complete',
    albums.every((a) => (a.complete ? a.state === 'archived' : a.state === 'idle')));

  // A resolved track path must actually exist on the drive — this is the assertion
  // that catches a wrong root, which would otherwise look like an empty library.
  let resolvable = 0;
  let checked = 0;
  for (const a of albums) {
    const t = a.tracks.find((x) => x.verified);
    if (!t) continue;
    checked++;
    if (fs.existsSync(path.join(a.root, t.path))) resolvable++;
  }
  check('root + track path resolves on disk for every album',
    checked > 0 && resolvable === checked, resolvable + '/' + checked);

  // Re-running must not duplicate anything.
  const before = library.size;
  const again = await importFromMagnets({
    library, magnets, cacheDir: CACHE, downloadRoot, now: null,
  });
  check('re-import is idempotent', library.size === before && again.added === 0,
    'added ' + again.added + ', skipped ' + again.skipped);

  const totalTracks = albums.reduce((n, a) => n + a.tracks.length, 0);
  const bytes = fs.existsSync(path.join(dir, 'albums.jsonl'))
    ? fs.statSync(path.join(dir, 'albums.jsonl')).size
    : 0;
  console.log(
    '\n  index: ' + albums.length + ' albums, ' + totalTracks + ' tracks, ' +
      (bytes / 1024).toFixed(0) + ' KB'
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (failures ? '  ' + failures + ' FAILED' : '  all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
