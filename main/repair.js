'use strict';

/**
 * Patches a damaged audio file by decoding past the broken part and re-encoding.
 *
 * The case this exists for is a release that is damaged at source. Re-downloading
 * cannot help — the bytes match the torrent's piece hashes, so every peer holds the
 * same broken file. The one that prompted this fails with
 * `FRAME_CRC_MISMATCH after processing 12999168 samples`, 294.8s into a 366s track,
 * and playback stops dead there.
 *
 * ffmpeg's decoder is more forgiving than Chromium's: it skips the unreadable frame
 * and carries on. Re-encoding what it produces gives a file that decodes cleanly all
 * the way through, with a discontinuity where the bad frame was. A FLAC frame is
 * about 100ms, so that is inaudible in practice — but it is a patch, not a
 * restoration, and nothing here should imply the lost audio came back.
 *
 * ffmpeg is not bundled. It is a ~70 MB binary that would need signing alongside the
 * app, for a feature most albums never need, so this looks for one already installed
 * and the UI offers the option only when it finds one.
 *
 * The repaired file is written *beside* the original rather than over it. That is
 * what lets the album keep seeding: the torrent's own file stays byte-intact, so
 * webtorrent still hashes it as valid, and the index points playback at the sibling.
 * Overwriting would put the album permanently out of the swarm.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Where to look for ffmpeg.
 *
 * A GUI app inherits almost no PATH on macOS — launched from Finder it is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which is why `which ffmpeg` cannot be relied on
 * even when a terminal finds it instantly. These are the two Homebrew prefixes
 * (Apple silicon, Intel) plus the system location.
 */
const FFMPEG_CANDIDATES = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

/** Same, for the reference FLAC tools — used to verify a repair when available. */
const FLAC_CANDIDATES = ['/opt/homebrew/bin/flac', '/usr/local/bin/flac', '/usr/bin/flac'];

/**
 * Only lossless inputs.
 *
 * Re-encoding a lossy file means decoding and re-compressing it, which degrades
 * every part of the track to patch one frame — a bad trade to make on a user's
 * behalf. Lossy formats are also far more tolerant of damage: an mp3 decoder glitches
 * through a bad frame rather than stopping, so this rarely comes up for them.
 */
const REPAIRABLE_EXTENSIONS = ['.flac', '.wav', '.aif', '.aiff'];

const SUFFIX = ' (repaired)';
/** Generous: this is a full decode and re-encode of a large file off USB. */
const TIMEOUT_MS = 10 * 60 * 1000;

/** @returns {string|null} the first candidate that exists, or an override. */
function findTool(candidates, env, exists) {
  const existsFn = exists || fs.existsSync;
  const override = env && env.MP_FFMPEG;
  if (override && candidates === FFMPEG_CANDIDATES && existsFn(override)) return override;
  for (const candidate of candidates) {
    if (existsFn(candidate)) return candidate;
  }
  return null;
}

function findFfmpeg(env, exists) {
  return findTool(FFMPEG_CANDIDATES, env || process.env, exists);
}

function findFlac(env, exists) {
  return findTool(FLAC_CANDIDATES, env || process.env, exists);
}

/** Whether a repair is even meaningful for this file. */
function isRepairable(relPath) {
  return REPAIRABLE_EXTENSIONS.indexOf(path.extname(String(relPath || '')).toLowerCase()) !== -1;
}

/**
 * The sibling path for a repaired copy: same directory, always `.flac`.
 *
 * `09 - Cuckoo.flac` → `09 - Cuckoo (repaired).flac`. Always FLAC because that is
 * what is written, whatever went in — a `.wav` name holding FLAC bytes would be
 * served as `audio/wav` from the extension map in file-server.js, and Chromium
 * refuses to decode audio whose declared type does not match.
 *
 * Relative, because that is what the index stores: `root` is joined at use time, so
 * moving the drive stays a one-field change.
 */
function repairedPathFor(relPath) {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, path.extname(relPath));
  const name = base + SUFFIX + '.flac';
  return dir === '.' ? name : dir + '/' + name;
}

/** True for a path this module produced, so a repair is never repaired again. */
function isRepairedPath(relPath) {
  const ext = path.extname(String(relPath || ''));
  return path.basename(String(relPath || ''), ext).endsWith(SUFFIX);
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    // No shell, and arguments as an array: every path here comes from torrent
    // metadata, and a filename containing a quote or a semicolon must be inert.
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stderr.on('data', (d) => {
      // Bounded: a pathological file could otherwise produce megabytes of warnings.
      if (stderr.length < 64 * 1024) stderr += String(d);
    });
    child.on('error', (err) => finish({ code: -1, stderr: err.message }));
    child.on('close', (code) => finish({ code: code, stderr: stderr }));

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stderr: 'timed out after ' + Math.round(timeoutMs / 1000) + 's' });
    }, timeoutMs);
  });
}

/**
 * Decode `src` past its damage and write a clean copy to `outAbs`.
 *
 * Writes to a temporary file in the same directory first, so the destination either
 * does not exist or is a complete verified file — never a half-written one that the
 * index would then point playback at. Same directory because a rename is only atomic
 * within a filesystem, and the library is on a different volume from tmp.
 *
 * @returns {Promise<{ok: boolean, bytes?: number, verifiedWith?: string, error?: string}>}
 */
async function repairFile({ ffmpeg, flac, srcAbs, outAbs, timeoutMs }) {
  if (!ffmpeg) return { ok: false, error: 'ffmpeg was not found on this system.' };

  let srcSize = 0;
  try {
    const st = await fsp.stat(srcAbs);
    srcSize = st.size;
  } catch (_) {
    return { ok: false, error: 'The original file is not on disk.' };
  }

  const tmpAbs = outAbs + '.part';
  await fsp.rm(tmpAbs, { force: true });

  // `-f flac` is not redundant: the temp file ends in `.part`, and without an
  // explicit format ffmpeg tries to infer one from the extension and refuses outright
  // with "Unable to choose an output format".
  //
  // -nostdin so it can never wait on input; -v error so stderr carries only real
  // problems; -y because the temp path is ours and may be left over from a crash.
  const encode = await run(
    ffmpeg,
    ['-nostdin', '-v', 'error', '-y', '-i', srcAbs, '-c:a', 'flac', '-f', 'flac', tmpAbs],
    timeoutMs || TIMEOUT_MS
  );
  if (encode.code !== 0) {
    await fsp.rm(tmpAbs, { force: true });
    return { ok: false, error: 'ffmpeg could not read this file: ' + firstLine(encode.stderr) };
  }

  let outSize = 0;
  try {
    const st = await fsp.stat(tmpAbs);
    outSize = st.size;
  } catch (_) {
    return { ok: false, error: 'ffmpeg reported success but wrote nothing.' };
  }

  // A patch drops one frame out of thousands, so the result should be within a few
  // percent of the original. Half the size means ffmpeg gave up early and wrote only
  // the part before the damage, which would be a worse file presented as a fix.
  if (outSize < srcSize * 0.5) {
    await fsp.rm(tmpAbs, { force: true });
    return {
      ok: false,
      error:
        'The repaired file came out far smaller than the original (' + outSize + ' vs ' +
        srcSize + ' bytes), so the damage is more than one frame. Not using it.',
    };
  }

  // Verify with the reference decoder when it is installed. `flac -t` checks every
  // frame's CRC, which is exactly the failure being repaired, so it is the only check
  // that actually proves the job was done.
  let verifiedWith = null;
  if (flac) {
    const test = await run(flac, ['-t', '--silent', tmpAbs], timeoutMs || TIMEOUT_MS);
    if (test.code !== 0) {
      await fsp.rm(tmpAbs, { force: true });
      return { ok: false, error: 'The repaired file still fails verification: ' + firstLine(test.stderr) };
    }
    verifiedWith = 'flac -t';
  } else {
    // Fall back to a full decode through ffmpeg. Weaker — it is the same lenient
    // decoder that produced the file — but it still catches a truncated write.
    const test = await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', tmpAbs, '-f', 'null', '-'],
      timeoutMs || TIMEOUT_MS);
    if (test.code !== 0) {
      await fsp.rm(tmpAbs, { force: true });
      return { ok: false, error: 'The repaired file does not decode: ' + firstLine(test.stderr) };
    }
    verifiedWith = 'ffmpeg decode';
  }

  await fsp.rename(tmpAbs, outAbs);
  return { ok: true, bytes: outSize, verifiedWith: verifiedWith };
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim());
  return (line || 'no detail').trim().slice(0, 200);
}

module.exports = {
  findFfmpeg,
  findFlac,
  isRepairable,
  repairedPathFor,
  isRepairedPath,
  repairFile,
  REPAIRABLE_EXTENSIONS,
  SUFFIX,
};
