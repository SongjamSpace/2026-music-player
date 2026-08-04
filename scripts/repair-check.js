#!/usr/bin/env node
'use strict';

/**
 * Checks main/repair.js — patching a file that is damaged in the release itself.
 *
 * Two halves. The path and eligibility rules run everywhere and are pure. The actual
 * repair needs ffmpeg, which is not bundled, so that half is skipped with a note when
 * ffmpeg is absent rather than failing the suite — `npm run check` has to pass on a
 * machine without it.
 *
 * The end-to-end case builds its own patient: ffmpeg synthesises a valid FLAC, a
 * frame in the middle is overwritten with garbage, and `flac -t` is asked to confirm
 * that the result really is broken before the repair is attempted. Without that
 * confirmation a passing test would prove nothing — it could be repairing a file that
 * was never damaged.
 *
 *   node scripts/repair-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const repair = require('../main/repair');

let failures = 0;
let skipped = 0;

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(54) +
      (ok ? String(actual).slice(0, 40) : 'got ' + actual + ', expected ' + expected)
  );
}

function skip(name, why) {
  skipped++;
  console.log('  SKIP  ' + name.padEnd(54) + why);
}

async function main() {
  console.log('');

  // -- which files are worth repairing -------------------------------------
  {
    // Lossless only. Patching a lossy file means re-compressing the whole track to
    // fix one frame, and lossy decoders glitch through damage rather than stopping.
    check('flac is repairable', repair.isRepairable('a/b/09 - Cuckoo.flac'), true);
    check('wav is repairable', repair.isRepairable('x.wav'), true);
    check('aiff is repairable', repair.isRepairable('x.AIFF'), true);
    check('mp3 is not', repair.isRepairable('x.mp3'), false);
    check('m4a is not', repair.isRepairable('x.m4a'), false);
    check('no extension is not', repair.isRepairable('x'), false);
    check('an empty path is not', repair.isRepairable(''), false);
    check('null is not', repair.isRepairable(null), false);
  }

  // -- where the repaired copy goes ----------------------------------------
  {
    // Beside the original, keeping directory and extension, so the torrent's own file
    // stays intact and the album keeps seeding.
    check('sibling path, nested',
      repair.repairedPathFor('Album/CD1/09 - Cuckoo.flac'),
      'Album/CD1/09 - Cuckoo (repaired).flac');
    // Always .flac, whatever went in: the sibling holds FLAC bytes, and a .wav name
    // would be served as audio/wav from the extension map and refused by Chromium.
    check('sibling path, flat', repair.repairedPathFor('track.wav'), 'track (repaired).flac');
    check('an aiff input still yields a flac sibling',
      repair.repairedPathFor('a/x.aiff'), 'a/x (repaired).flac');
    check('a dot in the name is not the extension',
      repair.repairedPathFor('a/Mr. Bungle - 01.flac'), 'a/Mr. Bungle - 01 (repaired).flac');

    // Recognising its own output is what stops a repair being repaired.
    check('recognises its own output', repair.isRepairedPath('a/x (repaired).flac'), true);
    check('...and leaves others alone', repair.isRepairedPath('a/x.flac'), false);
    check('...not fooled by a suffix mid-name',
      repair.isRepairedPath('a/x (repaired) live.flac'), false);
    check('round trip is idempotent-safe',
      repair.isRepairedPath(repair.repairedPathFor('a/x.flac')), true);
  }

  // -- tool discovery ------------------------------------------------------
  {
    const none = () => false;
    check('no ffmpeg anywhere → null', repair.findFfmpeg({}, none), null);
    const only = (p) => p === '/usr/local/bin/ffmpeg';
    check('finds the Intel Homebrew path', repair.findFfmpeg({}, only), '/usr/local/bin/ffmpeg');
    // An override matters for a machine that keeps it somewhere else entirely; a GUI
    // app inherits almost no PATH, so `which` cannot be relied on.
    check('MP_FFMPEG overrides discovery',
      repair.findFfmpeg({ MP_FFMPEG: '/opt/mine/ffmpeg' }, (p) => p === '/opt/mine/ffmpeg'),
      '/opt/mine/ffmpeg');
    check('a bogus override is ignored',
      repair.findFfmpeg({ MP_FFMPEG: '/nope/ffmpeg' }, only), '/usr/local/bin/ffmpeg');
  }

  // -- the real thing ------------------------------------------------------
  const ffmpeg = repair.findFfmpeg();
  const flac = repair.findFlac();
  if (!ffmpeg) {
    skip('end-to-end repair', 'ffmpeg not installed');
    console.log(
      '\n  ' + (failures ? failures + ' FAILED' : 'all checks passed') +
        (skipped ? ' (' + skipped + ' skipped)' : '') + '\n'
    );
    process.exit(failures ? 1 : 0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-repair-'));
  const srcAbs = path.join(tmp, 'tone.flac');

  // 12 seconds of tone: long enough to hold many frames, small enough to be quick.
  const made = spawnSync(ffmpeg, [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12',
    '-ac', '2', '-c:a', 'flac', srcAbs,
  ]);
  if (made.status !== 0) {
    skip('end-to-end repair', 'could not synthesise a fixture');
  } else {
    const clean = fs.readFileSync(srcAbs);
    check('fixture was created', clean.length > 1000, true);

    // Corrupt a run of bytes in the middle. Not the header — that would make the file
    // unopenable, which is a different failure with a different fix.
    const damaged = Buffer.from(clean);
    const at = Math.floor(damaged.length * 0.5);
    for (let i = 0; i < 4096; i++) damaged[at + i] = (i * 37) & 0xff;
    fs.writeFileSync(srcAbs, damaged);

    // Prove the patient is actually ill before claiming to cure it.
    if (flac) {
      const before = spawnSync(flac, ['-t', '--silent', srcAbs]);
      check('the fixture really is damaged', before.status !== 0, true);
    } else {
      skip('the fixture really is damaged', 'flac not installed');
    }

    const outAbs = path.join(tmp, repair.repairedPathFor('tone.flac'));
    const result = await repair.repairFile({ ffmpeg, flac, srcAbs, outAbs, timeoutMs: 120000 });

    check('repair reports success', result.ok, true);
    if (result.ok) {
      check('...wrote the sibling file', fs.existsSync(outAbs), true);
      check('...and it is not empty', fs.statSync(outAbs).size > 1000, true);
      check('...the original is untouched',
        fs.readFileSync(srcAbs).equals(damaged), true);
      check('...no temp file left behind', fs.existsSync(outAbs + '.part'), false);
      if (flac) {
        const after = spawnSync(flac, ['-t', '--silent', outAbs]);
        check('...the repaired file passes flac -t', after.status, 0);
        check('...and the repair says it verified it', result.verifiedWith, 'flac -t');
      }
    } else {
      console.log('    error was: ' + result.error);
    }

    // A file that is not there must fail cleanly rather than write a stub.
    const missing = await repair.repairFile({
      ffmpeg, flac,
      srcAbs: path.join(tmp, 'nope.flac'),
      outAbs: path.join(tmp, 'nope (repaired).flac'),
      timeoutMs: 30000,
    });
    check('a missing source fails cleanly', missing.ok, false);
    check('...and writes nothing', fs.existsSync(path.join(tmp, 'nope (repaired).flac')), false);

    // Garbage in must not produce a confident "repaired" out.
    const junkAbs = path.join(tmp, 'junk.flac');
    fs.writeFileSync(junkAbs, Buffer.alloc(50000, 7));
    const junk = await repair.repairFile({
      ffmpeg, flac, srcAbs: junkAbs,
      outAbs: path.join(tmp, 'junk (repaired).flac'),
      timeoutMs: 30000,
    });
    check('a file that is not audio at all fails', junk.ok, false);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    '\n' + (failures ? failures + ' FAILED' : 'all checks passed') +
      (skipped ? ' (' + skipped + ' skipped)' : '') + '\n'
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
