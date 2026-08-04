'use strict';

/**
 * One long-lived localhost server for media and artwork that is already on disk.
 *
 * Why this exists: a fully-downloaded FLAC was still being streamed through
 * WebTorrent's own per-torrent HTTP server, which means every read went through
 * the piece store of a torrent that had to be *live* for playback to work at all.
 * That is what tied "can I play this album" to "is this album a running torrent",
 * and therefore tied memory to library size. Reading the file directly severs it.
 *
 * Deliberately HTTP on 127.0.0.1 rather than a custom `mp://` protocol:
 *
 *   - CSP. renderer/index.html already allows `media-src http://127.0.0.1:*` and
 *     `img-src … http://127.0.0.1:*`. This needs no CSP change at all. A custom
 *     scheme needs both a CSP edit and protocol.registerSchemesAsPrivileged with
 *     exactly the right flag set, and getting one wrong fails silently at runtime.
 *   - CORS. installStreamCorsHeaders() in main/index.js already pins
 *     Access-Control-Allow-Origin onto every http://127.0.0.1: response, because
 *     the renderer's origin over file:// is the string "null". A new local server
 *     inherits that for free, so the DSP CORS probe sees the same shape it always
 *     has — and createMediaElementSource is irreversible, so "the probe behaves
 *     differently now" is not a risk worth taking in the same change.
 *   - Range requests. Chromium's media stack needs 206 to seek in FLAC and WAV.
 *     fs.createReadStream({start, end}) is the boring, well-trodden way to do it.
 *
 * A custom protocol remains a reasonable later cleanup — it would remove the port,
 * the token and the webRequest hook — but not at the same time as the change that
 * makes local playback work at all.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Extension → Content-Type.
 *
 * Never derived from webtorrent's `file.type`, which is always
 * `application/octet-stream` (see the note in renderer/js/util.js). Chromium will
 * refuse to decode audio served with the wrong type, so this has to be explicit.
 */
const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Concurrency caps on open read streams, counted separately per kind.
 *
 * The library is on an external drive; a renderer bug that opened a stream per row
 * would hold hundreds of file descriptors against a spinning USB disk.
 *
 * Media and art get their own budget because they used to share one, and a screen
 * full of cover art could then starve a media read — which surfaces as a 503 that
 * the media element reports as an unhelpfully generic error. Playback must never
 * be able to lose a slot to a thumbnail. Six covers the media working set with room
 * to spare: Chromium opens two connections per element, and the DSP probe adds a
 * second element on the first play of a session.
 */
const MAX_MEDIA_STREAMS = 6;
const MAX_ART_STREAMS = 6;
// Kept for the existing check harness and as the overall descriptor ceiling.
const MAX_CONCURRENT_STREAMS = MAX_MEDIA_STREAMS + MAX_ART_STREAMS;

/**
 * Parse a single-range `Range` header.
 *
 * Only the single-range form is supported, which is all Chromium's media stack
 * sends. A multi-range request would need multipart/byteranges; returning null
 * here makes the caller answer with the whole body, which is a legal response to
 * a Range it does not honour.
 *
 * @returns {{start: number, end: number}|null|'unsatisfiable'}
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (!hasStart) {
    // `bytes=-500` — the final 500 bytes.
    const suffix = Number(m[2]);
    if (!suffix) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  }

  if (!isFinite(start) || !isFinite(end)) return null;
  if (start > end || start >= size) return 'unsatisfiable';
  // A range that runs past the end is clamped, not rejected.
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * @param {object} deps
 * @param {function(string): {root: string, relPath: string}|null} deps.resolveMedia
 *   Maps an album id and track index onto a location on disk. Returning null means
 *   404. Injected rather than reaching into the torrent service so this module can
 *   be tested without Electron or webtorrent — see scripts/range-check.js.
 * @param {function(string, string): string|null=} deps.resolveArt
 *   Maps an album id and variant onto an absolute path.
 */
function createFileServer({ resolveMedia, resolveArt }) {
  // Regenerated every launch. Without it any other local process could enumerate
  // the whole library by walking /media/<id>/0, /1, … — the loopback interface is
  // not a permission boundary.
  const token = crypto.randomBytes(16).toString('hex');

  let server = null;
  let baseUrl = null;
  const open = { media: 0, art: 0 };

  function deny(res, code, message) {
    res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(message || String(code));
  }

  /**
   * Confirm the resolved file really sits under the root it claims to.
   *
   * realpath on both sides, because a relative path is attacker-controlled in the
   * sense that it comes from torrent metadata, and `..` in a torrent's file path
   * is a known bad-torrent trick. Comparing resolved strings without realpath
   * would also be fooled by a symlink inside the library.
   */
  async function safeJoin(root, relPath) {
    const target = path.resolve(root, relPath);
    let realTarget;
    let realRoot;
    try {
      realRoot = await fsp.realpath(root);
      realTarget = await fsp.realpath(target);
    } catch (_) {
      return null; // missing file, or missing root (drive unplugged)
    }
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realTarget !== realRoot && !realTarget.startsWith(prefix)) return null;
    return realTarget;
  }

  async function serveFile(req, res, filePath, { immutable, kind }) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (_) {
      return deny(res, 404, 'not found');
    }
    if (!stat.isFile()) return deny(res, 404, 'not a file');

    const size = stat.size;
    const range = parseRange(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'Content-Range': 'bytes */' + size,
        'Content-Type': 'text/plain',
        'Accept-Ranges': 'bytes',
      });
      return res.end('range not satisfiable');
    }

    const headers = {
      'Content-Type': contentTypeFor(filePath),
      'Accept-Ranges': 'bytes',
      // Media must not be cached: the same URL serves a file that can be replaced
      // on disk. Art URLs carry a version, so they can be cached hard.
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    };

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    // Inclusive on both ends, so the length is end - start + 1. Off-by-one here
    // shows up as audio that will not seek, which is hard to trace back.
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;

    // HEAD gets identical headers and no body — Chromium probes with it before
    // deciding whether it can seek.
    if (req.method === 'HEAD') {
      res.writeHead(range ? 206 : 200, headers);
      return res.end();
    }

    const budget = kind === 'art' ? MAX_ART_STREAMS : MAX_MEDIA_STREAMS;
    if (open[kind] >= budget) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
      return res.end('too many concurrent reads');
    }

    res.writeHead(range ? 206 : 200, headers);
    if (size === 0) return res.end();

    open[kind]++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      open[kind]--;
    };

    const stream = fs.createReadStream(filePath, { start, end });
    // A seek or a closed tab aborts the response; without this the descriptor
    // stays open against the external drive until GC gets round to it.
    res.on('close', () => {
      stream.destroy();
      release();
    });
    stream.on('error', () => {
      release();
      res.destroy();
    });
    stream.on('end', release);
    stream.pipe(res);
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    let parsed;
    try {
      parsed = new URL(req.url, 'http://127.0.0.1');
    } catch (_) {
      return deny(res, 400, 'bad url');
    }

    // decodeURIComponent per segment, so an encoded '/' in a filename cannot
    // create extra path segments.
    const segments = parsed.pathname.split('/').filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch (_) {
        return s;
      }
    });

    // /<token>/<kind>/<id>/<rest>
    if (segments.length < 4) return deny(res, 404, 'not found');
    // Fixed-length compare, so a wrong token cannot be probed by timing.
    const given = Buffer.from(segments[0]);
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return deny(res, 403, 'forbidden');
    }

    const kind = segments[1];
    const id = segments[2];

    if (kind === 'media') {
      const index = Number(segments[3]);
      if (!Number.isInteger(index) || index < 0) return deny(res, 400, 'bad index');
      const loc = resolveMedia(id, index);
      if (!loc) return deny(res, 404, 'unknown track');
      const filePath = await safeJoin(loc.root, loc.relPath);
      if (!filePath) return deny(res, 404, 'not found');
      return serveFile(req, res, filePath, { immutable: false, kind: 'media' });
    }

    if (kind === 'art') {
      if (typeof resolveArt !== 'function') return deny(res, 404, 'no art');
      const filePath = resolveArt(id, segments[3]);
      if (!filePath) return deny(res, 404, 'unknown art');
      return serveFile(req, res, filePath, { immutable: true, kind: 'art' });
    }

    return deny(res, 404, 'not found');
  }

  return {
    /** @returns {Promise<string>} the base URL, token included. */
    start() {
      if (baseUrl) return Promise.resolve(baseUrl);
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          // A throw in here would otherwise take the main process down, which is
          // not an acceptable outcome for a bad URL.
          handle(req, res).catch((err) => {
            console.error('[file-server]', req.url, '-', err.message);
            try {
              deny(res, 500, 'server error');
            } catch (_) {
              /* response already gone */
            }
          });
        });
        server.on('error', reject);
        // Port 0: unlike the torrent port there is nothing to forward, and a fixed
        // port would just be one more thing to collide with.
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          baseUrl = 'http://127.0.0.1:' + addr.port + '/' + token;
          resolve(baseUrl);
        });
      });
    },

    /** Null until start() resolves. */
    get url() {
      return baseUrl;
    },

    mediaUrl(albumId, index) {
      return baseUrl ? baseUrl + '/media/' + encodeURIComponent(albumId) + '/' + index : null;
    },

    artUrl(albumId, variant, version) {
      if (!baseUrl) return null;
      return (
        baseUrl + '/art/' + encodeURIComponent(albumId) + '/' + encodeURIComponent(variant) +
        (version ? '?v=' + encodeURIComponent(version) : '')
      );
    },

    stop() {
      if (!server) return Promise.resolve();
      const s = server;
      server = null;
      baseUrl = null;
      return new Promise((resolve) => s.close(resolve));
    },

    /** For diagnostics and tests. */
    stats() {
      return {
        listening: !!baseUrl,
        openStreams: open.media + open.art,
        openMedia: open.media,
        openArt: open.art,
      };
    },
  };
}

module.exports = {
  createFileServer,
  parseRange,
  contentTypeFor,
  MAX_CONCURRENT_STREAMS,
  MAX_MEDIA_STREAMS,
  MAX_ART_STREAMS,
};
