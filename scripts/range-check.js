#!/usr/bin/env node
'use strict';

/**
 * Checks main/file-server.js against a fixture file.
 *
 * Range handling is the part of local playback that fails quietly: get
 * `Content-Range` off by one, or answer 200 where Chromium expected 206, and audio
 * plays but will not seek — which reads as "scrubbing is broken", nowhere near the
 * code responsible. Byte-exactness is asserted, not just status codes.
 *
 * Needs no Electron, no webtorrent and no running app: the server takes its path
 * resolution as an injected function precisely so this can exist.
 *
 *   node scripts/range-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFileServer, parseRange, MAX_ART_STREAMS } = require('../main/file-server');

const SIZE = 5000;

let failures = 0;

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(56) +
      (ok ? String(actual).slice(0, 40) : 'got ' + actual + ', expected ' + expected)
  );
}

function request(url, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts || {}, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // Deterministic content, so a wrong offset is visible rather than plausible.
  const bytes = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 251;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-range-'));
  const root = path.join(tmp, 'Album');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'track.flac'), bytes);
  fs.writeFileSync(path.join(root, 'empty.flac'), Buffer.alloc(0));
  fs.writeFileSync(path.join(tmp, 'outside.flac'), Buffer.from('secret'));

  const server = createFileServer({
    resolveMedia: (id, index) => {
      if (id !== 'album1') return null;
      if (index === 0) return { root, relPath: 'track.flac' };
      if (index === 1) return { root, relPath: 'empty.flac' };
      // Deliberate traversal attempt, as a bad torrent's file path would be.
      if (index === 2) return { root, relPath: '../outside.flac' };
      return null;
    },
    resolveArt: (id, variant) => (variant === 'thumb' ? path.join(root, 'track.flac') : null),
  });

  const base = await server.start();
  console.log('');

  // -- whole file ----------------------------------------------------------
  {
    const r = await request(base + '/media/album1/0');
    check('whole file → 200', r.status, 200);
    check('...Content-Length is the file size', r.headers['content-length'], String(SIZE));
    check('...Accept-Ranges advertised', r.headers['accept-ranges'], 'bytes');
    check('...Content-Type from the extension, not octet-stream', r.headers['content-type'], 'audio/flac');
    check('...body is byte-exact', r.body.equals(bytes), true);
    check('...media is not cached', r.headers['cache-control'], 'no-store');
  }

  // -- open-ended range ----------------------------------------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'bytes=0-' } });
    check('bytes=0- → 206', r.status, 206);
    check('...Content-Range covers the whole file', r.headers['content-range'], 'bytes 0-4999/5000');
    check('...body is byte-exact', r.body.equals(bytes), true);
  }

  // -- closed range: the off-by-one that breaks seeking --------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'bytes=100-199' } });
    check('bytes=100-199 → 206', r.status, 206);
    check('...Content-Length is inclusive (100 bytes)', r.headers['content-length'], '100');
    check('...Content-Range is inclusive', r.headers['content-range'], 'bytes 100-199/5000');
    check('...body is exactly those bytes', r.body.equals(bytes.slice(100, 200)), true);
  }

  // -- suffix range --------------------------------------------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'bytes=-500' } });
    check('bytes=-500 → 206 (final 500 bytes)', r.status, 206);
    check('...Content-Range', r.headers['content-range'], 'bytes 4500-4999/5000');
    check('...body is the tail', r.body.equals(bytes.slice(4500)), true);
  }

  // -- range past the end is clamped, not rejected ------------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'bytes=4900-999999' } });
    check('range past EOF is clamped → 206', r.status, 206);
    check('...Content-Range stops at the last byte', r.headers['content-range'], 'bytes 4900-4999/5000');
    check('...body length', r.body.length, 100);
  }

  // -- unsatisfiable -------------------------------------------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'bytes=9000-9100' } });
    check('start beyond EOF → 416', r.status, 416);
    check('...Content-Range reports the size', r.headers['content-range'], 'bytes */5000');
  }

  // -- malformed range is ignored, per spec -------------------------------
  {
    const r = await request(base + '/media/album1/0', { headers: { Range: 'pages=1-2' } });
    check('malformed Range is ignored → 200', r.status, 200);
    check('...full body returned', r.body.length, SIZE);
  }

  // -- HEAD ----------------------------------------------------------------
  {
    const r = await request(base + '/media/album1/0', { method: 'HEAD' });
    check('HEAD → 200 with no body', r.status + ':' + r.body.length, '200:0');
    check('...still advertises the size', r.headers['content-length'], String(SIZE));
    const r2 = await request(base + '/media/album1/0', {
      method: 'HEAD',
      headers: { Range: 'bytes=10-19' },
    });
    check('HEAD with Range → 206 and headers only', r2.status + ':' + r2.body.length, '206:0');
    check('...Content-Range present', r2.headers['content-range'], 'bytes 10-19/5000');
  }

  // -- empty file ----------------------------------------------------------
  {
    const r = await request(base + '/media/album1/1');
    check('zero-length file → 200 with no body', r.status + ':' + r.body.length, '200:0');
  }

  // -- security ------------------------------------------------------------
  {
    const r = await request(base + '/media/album1/2');
    check('path traversal out of the album root → 404', r.status, 404);
  }
  {
    const r = await request(base + '/media/album1/99');
    check('unknown track index → 404', r.status, 404);
  }
  {
    const r = await request(base + '/media/nope/0');
    check('unknown album → 404', r.status, 404);
  }
  {
    // Same path, wrong token: another local process must not be able to read the
    // library just by knowing the port.
    const wrong = base.replace(/\/[0-9a-f]{32}$/, '/' + 'f'.repeat(32));
    const r = await request(wrong + '/media/album1/0');
    check('wrong session token → 403', r.status, 403);
  }
  {
    const r = await request(base.replace(/\/[0-9a-f]{32}$/, '/short') + '/media/album1/0');
    check('short token → 403 (no length crash)', r.status, 403);
  }
  {
    const r = await request(base + '/media/album1/0', { method: 'POST' });
    check('POST → 405', r.status, 405);
  }
  {
    const r = await request(base + '/nonsense');
    check('unknown path shape → 404', r.status, 404);
  }

  // -- art -----------------------------------------------------------------
  {
    const r = await request(base + '/art/album1/thumb');
    check('art → 200', r.status, 200);
    check('...art is cached hard', /immutable/.test(r.headers['cache-control'] || ''), true);
    const r2 = await request(base + '/art/album1/hero');
    check('unknown art variant → 404', r2.status, 404);
  }

  // -- art cannot starve media --------------------------------------------
  {
    // The two kinds used to share one budget, so a screen full of cover art could
    // take every slot and a media read would answer 503 — which Chromium reports
    // as a generic media error, and the renderer then blamed on CORS. Saturate art
    // and assert playback is still served.
    const held = [];
    for (let i = 0; i < MAX_ART_STREAMS + 2; i++) held.push(request(base + '/art/album1/thumb'));
    const media = await request(base + '/media/album1/0', { headers: { Range: 'bytes=0-99' } });
    check('media is served while art is saturated', media.status, 206);
    check('...and the bytes are right', media.body.equals(bytes.subarray(0, 100)), true);
    await Promise.all(held);
  }

  // -- parseRange unit cases ----------------------------------------------
  {
    check('parseRange: no header', parseRange(undefined, 100), null);
    check('parseRange: bytes=- is not a range', parseRange('bytes=-', 100), null);
    check('parseRange: bytes=-0 is unsatisfiable', parseRange('bytes=-0', 100), 'unsatisfiable');
    check('parseRange: start > end', parseRange('bytes=50-10', 100), 'unsatisfiable');
    check('parseRange: exact last byte', JSON.stringify(parseRange('bytes=99-99', 100)), '{"start":99,"end":99}');
  }

  // -- no descriptor leak --------------------------------------------------
  {
    // Every request above completed, so nothing should still be held open against
    // the disk. A leak here would show up as 503s in normal use.
    check('no read streams left open', server.stats().openStreams, 0);
  }

  await server.stop();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
