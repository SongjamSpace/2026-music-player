#!/usr/bin/env node
'use strict';

/**
 * Checks main/library.js — the persistent album index.
 *
 * The properties that matter are the ones that only show up after something goes
 * wrong: a torn final line from a crash mid-append must not make the library
 * unreadable, a compaction interrupted halfway must not lose records, and a
 * deletion must not come back to life on the next load. Those are exactly the cases
 * nobody exercises by hand.
 *
 *   node scripts/library-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary, RECORD_VERSION } = require('../main/library');
const { classifyTrackFile } = require('../main/library-import');

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(56) +
      (ok ? String(JSON.stringify(actual)).slice(0, 30) : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  );
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-library-'));
}

function album(id, extra) {
  return Object.assign(
    {
      id: id,
      name: 'Album ' + id,
      root: '/Volumes/My Book/Files/2026-Music-Player/Album ' + id,
      state: 'archived',
      complete: true,
      tracks: [
        { i: 0, path: 'Album ' + id + '/01.flac', name: '01.flac', length: 100, verified: true },
        { i: 1, path: 'Album ' + id + '/02.flac', name: '02.flac', length: 200, verified: true },
      ],
    },
    extra
  );
}

async function main() {
  console.log('');

  // -- round trip ----------------------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.upsert(album('bbb'));
    check('two albums stored', lib.size, 2);
    check('get() returns the record', lib.get('aaa').name, 'Album aaa');
    check('tracks() returns nested tracks', lib.tracks('aaa').length, 2);
    check('unknown id is null', lib.get('zzz'), null);

    // A fresh instance over the same directory is what a restart looks like.
    const reopened = createLibrary({ dir });
    await reopened.load();
    check('survives a reload', reopened.size, 2);
    check('...with track detail intact', reopened.tracks('bbb')[1].length, 200);
    check('...and the version stamped', reopened.get('bbb').v, RECORD_VERSION);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- latest wins ---------------------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa', { name: 'first' }));
    await lib.upsert(album('aaa', { name: 'second' }));
    await lib.patch('aaa', { name: 'third' });
    check('duplicate ids collapse to one album', lib.size, 1);
    check('last write wins in memory', lib.get('aaa').name, 'third');

    const reopened = createLibrary({ dir });
    await reopened.load();
    check('last write wins after reload', reopened.get('aaa').name, 'third');
    check('...still one album', reopened.size, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- patch semantics -----------------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.patch('aaa', { state: 'seeding' });
    check('patch merges rather than replaces', lib.get('aaa').tracks.length, 2);
    check('...and applies the field', lib.get('aaa').state, 'seeding');
    check('patching an unknown id is a no-op', await lib.patch('nope', { state: 'idle' }), false);
    check('...and does not create it', lib.size, 1);

    // The index is the UI's data source, so a caller must not be able to corrupt
    // it by holding onto what it read.
    const copy = lib.get('aaa');
    copy.name = 'mutated';
    copy.tracks[0].name = 'mutated';
    check('get() returns a copy, not the live record', lib.get('aaa').name, 'Album aaa');
    check('tracks() returns copies too', lib.tracks('aaa')[0].name, '01.flac');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- writes that change nothing must not grow the log --------------------
  {
    // The index is refreshed from every live torrent on every launch, so without
    // this a launch that changed nothing still appended the whole library again.
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.flush();
    const after1 = lib.stats().logLines;

    await lib.upsert(album('aaa'));
    await lib.upsert(album('aaa'));
    await lib.patch('aaa', { state: 'archived' }); // already archived
    await lib.flush();
    check('identical writes are skipped', lib.stats().logLines, after1);

    await lib.patch('aaa', { state: 'seeding' });
    await lib.flush();
    check('a real change still appends', lib.stats().logLines, after1 + 1);
    check('...and is applied', lib.get('aaa').state, 'seeding');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- deletion is durable -------------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.upsert(album('bbb'));
    check('remove() reports success', await lib.remove('aaa'), true);
    check('removing twice is a no-op', await lib.remove('aaa'), false);
    check('one album left', lib.size, 1);

    // Without a tombstone the earlier upsert would simply be replayed.
    const reopened = createLibrary({ dir });
    await reopened.load();
    check('deletion survives reload', reopened.has('aaa'), false);
    check('...and the other album is untouched', reopened.has('bbb'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- a torn final line (crash mid-append) --------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.upsert(album('bbb'));
    await lib.flush();

    // Exactly what a crash partway through appendFile leaves behind.
    const logPath = path.join(dir, 'albums.jsonl');
    fs.appendFileSync(logPath, '{"id":"ccc","name":"half-writt');

    const reopened = createLibrary({ dir });
    await reopened.load();
    check('torn line is discarded, not fatal', reopened.size, 2);
    check('...earlier records still load', reopened.has('aaa'), true);
    check('...the torn record is absent', reopened.has('ccc'), false);

    // And the index must still be writable afterwards.
    await reopened.upsert(album('ddd'));
    const third = createLibrary({ dir });
    await third.load();
    check('still writable after a torn line', third.has('ddd'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- junk lines ----------------------------------------------------------
  {
    const dir = tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'albums.jsonl'),
      '\n' +
        'not json at all\n' +
        JSON.stringify({ name: 'no id here' }) + '\n' +
        JSON.stringify(album('good')) + '\n' +
        '   \n'
    );
    const lib = createLibrary({ dir });
    await lib.load();
    check('unparseable and id-less lines are skipped', lib.size, 1);
    check('...the valid record survives', lib.has('good'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- records from an older version --------------------------------------
  {
    const dir = tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    // No v, no tracks, no state, unknown state value.
    fs.writeFileSync(
      path.join(dir, 'albums.jsonl'),
      JSON.stringify({ id: 'old1', name: 'Ancient' }) + '\n' +
        JSON.stringify({ id: 'old2', state: 'nonsense-state' }) + '\n'
    );
    const lib = createLibrary({ dir });
    await lib.load();
    check('a record with no tracks loads', Array.isArray(lib.get('old1').tracks), true);
    check('...defaulting to an empty list', lib.tracks('old1').length, 0);
    check('an unknown state falls back to idle', lib.get('old2').state, 'idle');
    check('a missing name falls back to the id', lib.get('old2').name, 'old2');
    check('art defaults to pending', lib.get('old1').art.status, 'pending');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- compaction ----------------------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    // Enough patches to cross COMPACT_MIN_LINES.
    for (let i = 0; i < 250; i++) await lib.patch('aaa', { name: 'rev' + i });
    await lib.flush();

    const stats = lib.stats();
    check('log was compacted rather than growing forever', stats.logLines < 250, true);
    check('snapshot exists', fs.existsSync(path.join(dir, 'albums.snapshot')), true);
    check('no temp file left behind', fs.existsSync(path.join(dir, 'albums.snapshot.tmp')), false);
    check('still exactly one album', lib.size, 1);
    check('latest value survived compaction', lib.get('aaa').name, 'rev249');

    const reopened = createLibrary({ dir });
    await reopened.load();
    check('reload after compaction', reopened.get('aaa').name, 'rev249');
    check('...one album', reopened.size, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- snapshot plus later log entries -------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa', { name: 'in snapshot' }));
    await lib.compact();
    await lib.upsert(album('bbb', { name: 'only in log' }));
    await lib.patch('aaa', { name: 'updated after snapshot' });
    await lib.flush();

    const reopened = createLibrary({ dir });
    await reopened.load();
    // If the log were replayed before the snapshot, this would read 'in snapshot'.
    check('log is applied over the snapshot', reopened.get('aaa').name, 'updated after snapshot');
    check('...and log-only records load', reopened.get('bbb').name, 'only in log');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- interrupted compaction ---------------------------------------------
  {
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert(album('aaa'));
    await lib.upsert(album('bbb'));
    await lib.compact();
    // A crash between writing the temp snapshot and renaming it: the stale temp
    // file is present and must simply be ignored.
    fs.writeFileSync(path.join(dir, 'albums.snapshot.tmp'), 'garbage that must never be read\n');
    const reopened = createLibrary({ dir });
    await reopened.load();
    check('a stale .tmp snapshot is ignored', reopened.size, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- scale ---------------------------------------------------------------
  {
    // The stated target is thousands of albums. This is the load that decides
    // whether the whole-index-in-memory choice holds.
    const dir = tmpdir();
    const lib = createLibrary({ dir });
    await lib.load();
    const ALBUMS = 1000;
    const TRACKS = 10;
    const records = [];
    for (let a = 0; a < ALBUMS; a++) {
      const tracks = [];
      for (let t = 0; t < TRACKS; t++) {
        tracks.push({
          i: t,
          path: 'Album ' + a + '/' + String(t).padStart(2, '0') + ' Track.flac',
          name: String(t).padStart(2, '0') + ' Track.flac',
          length: 30000000,
          verified: true,
          dur: 240.5,
        });
      }
      records.push(album('id' + a, { tracks: tracks, name: 'Album number ' + a }));
    }
    // Bulk load then one compaction, which is what migration will do.
    for (const r of records) lib.upsert(r);
    await lib.flush();
    await lib.compact();

    const bytes = fs.statSync(path.join(dir, 'albums.snapshot')).size;
    const started = Date.now();
    const reopened = createLibrary({ dir });
    await reopened.load();
    const ms = Date.now() - started;

    console.log(
      '    scale: ' + ALBUMS + ' albums / ' + ALBUMS * TRACKS + ' tracks = ' +
        (bytes / 1048576).toFixed(1) + ' MB on disk, loaded in ' + ms + 'ms'
    );
    check('all albums loaded at scale', reopened.size, ALBUMS);
    check('index stays under 25 MB at 10k tracks', bytes < 25 * 1048576, true);
    // Generous, because CI machines vary; the point is that it is not seconds.
    check('loads in under 2s at 10k tracks', ms < 2000, true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- what a file on disk is, for an unverified track ---------------------
  {
    // The rule behind "drop a clean copy of a broken track into the folder and the
    // app serves it". Length is the only signal available without hashing, and it
    // only means anything when nothing is writing to the file — which is why
    // `downloading` is a parameter and not an assumption.
    const track = { length: 1000, verified: true };
    const c = classifyTrackFile;

    check('absent → missing', c(track, { exists: false, size: 0 }, false), 'missing');
    check('no stat at all → missing', c(track, null, false), 'missing');
    check('exact length → verified', c(track, { exists: true, size: 1000 }, false), 'verified');
    check('...even mid-download', c(track, { exists: true, size: 1000 }, true), 'verified');

    // The case this exists for: a hand-placed replacement, which is a different file
    // and therefore almost never the same length.
    check('different length, nothing downloading → substituted',
      c(track, { exists: true, size: 1234 }, false), 'substituted');
    check('shorter, nothing downloading → substituted',
      c(track, { exists: true, size: 40 }, false), 'substituted');

    // The direction that must not be permissive. A partial file grows as chunks
    // land, so calling that "substituted" would stop the download and leave a
    // truncated file being served as if the user had chosen it.
    check('different length while downloading → partial',
      c(track, { exists: true, size: 1234 }, true), 'partial');
    check('...shorter too', c(track, { exists: true, size: 40 }, true), 'partial');

    // The regression this rule was rewritten for. An unverified track with a wrong
    // length is an unfinished download, whatever is or isn't live — judging on length
    // and liveness alone marked 74 tracks of a 1%-downloaded album as hand-replaced,
    // and a hand-replaced track is never re-downloaded.
    const unvouched = { length: 1000, verified: false };
    check('unverified + wrong length → partial, not substituted',
      c(unvouched, { exists: true, size: 40 }, false), 'partial');
    check('...even with nothing live', c(unvouched, { exists: true, size: 999 }, false), 'partial');
    check('an unverified track can still reach the exact length',
      c(unvouched, { exists: true, size: 1000 }, false), 'verified');

    // A zero-length file is a stub, not a substitution.
    check('zero length → missing', c(track, { exists: true, size: 0 }, false), 'missing');
    check('a track with no known length is never verified',
      c({ length: 0 }, { exists: true, size: 0 }, false), 'missing');
  }

  // -- the substituted flag survives a round trip --------------------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lib-sub-'));
    const lib = createLibrary({ dir });
    await lib.load();
    await lib.upsert({
      id: 'a', name: 'A', complete: true, root: '/tmp/a',
      tracks: [
        { i: 0, path: 'a/1.flac', name: '1.flac', length: 10, verified: true },
        { i: 1, path: 'a/2.flac', name: '2.flac', length: 20, substituted: true },
      ],
    });
    await lib.flush();

    const reopened = createLibrary({ dir });
    await reopened.load();
    const back = reopened.get('a');
    check('substituted survives reload', back.tracks[1].substituted, true);
    check('...and does not leak onto other tracks', !!back.tracks[0].substituted, false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
