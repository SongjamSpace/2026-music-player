#!/usr/bin/env node
'use strict';

/**
 * Checks the guard that stops the app re-downloading the whole library.
 *
 * The failure it exists to prevent: the music lives on an external drive, so
 * `/Volumes/My Book/Files/2026-Music-Player` is just a path. Unmounted, macOS
 * lets a stub directory be created there; webtorrent then sees every torrent at
 * 0% and starts pulling 11+ GB back over the swarm. `existsSync` cannot catch
 * that, because after the first bad launch the stub directory does exist.
 *
 * The guard is therefore identity, not existence: a marker file holding a random
 * id, compared against the id in prefs. These are the cases that have to hold.
 *
 * `main/index.js` is an Electron module and cannot be required from plain node,
 * so the function under test is re-created here from the same logic. That is a
 * duplicate and worth being honest about — the assertions below are about the
 * decision table, and the table is what regresses.
 *
 *   node scripts/library-root-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIBRARY_MARKER = '.mp-library-id';

/** Mirror of checkLibraryRoot() in main/index.js. */
function checkLibraryRoot(root, adopt, store) {
  if (!root) return { ok: true };
  const markerPath = path.join(root, LIBRARY_MARKER);
  const expected = store.get('libraryId') || null;

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    return { ok: false, reason: 'missing', path: root };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'missing', path: root };

  let marker = null;
  try {
    marker = fs.readFileSync(markerPath, 'utf8').trim() || null;
  } catch (_) {
    /* no marker yet */
  }

  if (!expected) {
    if (!marker) {
      const hasLibrary = (store.get('magnets', []) || []).length > 0;
      let looksPopulated = false;
      try {
        looksPopulated = fs.readdirSync(root).some((n) => !n.startsWith('.'));
      } catch (_) {
        /* unreadable */
      }
      if (!adopt && hasLibrary && !looksPopulated) {
        return { ok: false, reason: 'empty', path: root };
      }
      marker = 'generated-' + Math.abs(root.length * 2654435761 % 1e9).toString(36);
      try {
        fs.writeFileSync(markerPath, marker);
      } catch (err) {
        return { ok: false, reason: 'unwritable', path: root, detail: err.message };
      }
    }
    store.set('libraryId', marker);
    return { ok: true };
  }

  if (!marker) return { ok: false, reason: 'unstamped', path: root };
  if (marker !== expected) return { ok: false, reason: 'mismatch', path: root };
  return { ok: true };
}

// -- harness ---------------------------------------------------------------

function fakeStore(initial) {
  const data = Object.assign({}, initial);
  return {
    get: (k, d) => (data[k] !== undefined ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    _data: data,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-libroot-'));
let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(58) +
      (ok ? String(actual) : 'got ' + actual + ', expected ' + expected)
  );
}

function freshDir(name) {
  const dir = path.join(tmp, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

console.log('');

// 1. THE bug. Library configured, root exists but is empty and unstamped —
//    exactly what an unmounted external drive looks like after one bad launch.
{
  const dir = freshDir('unmounted-stub');
  const store = fakeStore({ magnets: ['magnet:?xt=urn:btih:' + 'a'.repeat(40)] });
  const r = checkLibraryRoot(dir, false, store);
  check('unmounted drive stub is refused', r.ok + ':' + r.reason, 'false:empty');
  check('...and no marker was written into the stub', fs.existsSync(path.join(dir, LIBRARY_MARKER)), false);
}

// 2. Root gone entirely.
{
  const store = fakeStore({ libraryId: 'abc', magnets: ['x'] });
  const r = checkLibraryRoot(path.join(tmp, 'does-not-exist'), false, store);
  check('missing root is refused', r.ok + ':' + r.reason, 'false:missing');
}

// 3. Happy path: stamped root, matching id.
{
  const dir = freshDir('good');
  fs.writeFileSync(path.join(dir, LIBRARY_MARKER), 'known-id');
  const store = fakeStore({ libraryId: 'known-id', magnets: ['x'] });
  check('stamped root with matching id is accepted', checkLibraryRoot(dir, false, store).ok, true);
}

// 4. Drive remounted as "My Book 1" — a *different* real library at the path.
{
  const dir = freshDir('other-library');
  fs.writeFileSync(path.join(dir, LIBRARY_MARKER), 'some-other-id');
  const store = fakeStore({ libraryId: 'known-id', magnets: ['x'] });
  const r = checkLibraryRoot(dir, false, store);
  check('a different library at the same path is refused', r.ok + ':' + r.reason, 'false:mismatch');
}

// 5. Stamped in prefs but the marker is gone — the drive is not the one we
//    stamped, even though something is mounted there.
{
  const dir = freshDir('marker-gone');
  fs.writeFileSync(path.join(dir, 'Some Album.flac'), 'x');
  const store = fakeStore({ libraryId: 'known-id', magnets: ['x'] });
  const r = checkLibraryRoot(dir, false, store);
  check('populated root missing our marker is refused', r.ok + ':' + r.reason, 'false:unstamped');
}

// 6. First ever run: no library yet, so an empty root is legitimate and gets
//    adopted. This must not regress into refusing a clean install.
{
  const dir = freshDir('first-run');
  const store = fakeStore({ magnets: [] });
  const r = checkLibraryRoot(dir, false, store);
  check('first run on an empty root is adopted', r.ok, true);
  check('...and the marker was written', fs.existsSync(path.join(dir, LIBRARY_MARKER)), true);
  check('...and the id was recorded in prefs', !!store.get('libraryId'), true);
}

// 7. Migration: existing library, files really are on disk, just never stamped.
{
  const dir = freshDir('migrate');
  fs.mkdirSync(path.join(dir, 'Aphex Twin'));
  const store = fakeStore({ magnets: ['x'] });
  const r = checkLibraryRoot(dir, false, store);
  check('existing populated library is adopted on upgrade', r.ok, true);
  check('...and is stamped for next time', fs.existsSync(path.join(dir, LIBRARY_MARKER)), true);
}

// 8. The user deliberately picks a fresh empty folder to move the library to.
//    Same shape as case 1 and must be allowed, which is why `adopt` exists.
{
  const dir = freshDir('user-picked-empty');
  const store = fakeStore({ magnets: ['x'] });
  check('user-chosen empty folder is adopted', checkLibraryRoot(dir, true, store).ok, true);
}

// 9. A file where a directory should be.
{
  const file = path.join(tmp, 'a-file');
  fs.writeFileSync(file, 'x');
  const store = fakeStore({ libraryId: 'known-id', magnets: ['x'] });
  const r = checkLibraryRoot(file, false, store);
  check('a file instead of a directory is refused', r.ok + ':' + r.reason, 'false:missing');
}

// 10. Never configured — the built-in default applies and this must not block.
{
  check('no configured root is not an error', checkLibraryRoot(null, false, fakeStore({})).ok, true);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
process.exit(failures ? 1 : 0);
