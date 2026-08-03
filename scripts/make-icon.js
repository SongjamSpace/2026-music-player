#!/usr/bin/env node
'use strict';

/**
 * Generates build/icon.png (1024²) for the app bundle.
 *
 * Written as a raw PNG encoder rather than pulling in an image library: this
 * runs once at build time and a dependency for one gradient and a music note
 * isn't worth it. zlib is all Node needs to write a valid PNG.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 2; // supersample factor, for antialiased edges
const W = SIZE * SS;

// Matches the app's Midnight theme: desaturated accent over near-black.
const BG_TOP = [0x3f, 0x5f, 0x93];
const BG_BOTTOM = [0x15, 0x16, 0x22];
const FG = [0xf2, 0xf3, 0xf7];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Signed-distance helpers — cheaper to reason about than path filling. */
function inRoundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  return Math.hypot(dx, dy) <= r;
}

function inCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Rotated ellipse, for the note heads. */
function inEllipse(x, y, cx, cy, rx, ry, angle) {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const dx = x - cx;
  const dy = y - cy;
  const u = (dx * c - dy * s) / rx;
  const v = (dx * s + dy * c) / ry;
  return u * u + v * v <= 1;
}

function inRect(x, y, rx, ry, rw, rh) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

/** The glyph: two beamed note heads, in supersampled coordinates. */
function isNote(x, y) {
  const u = (x / W) * 1024;
  const v = (y / W) * 1024;

  const headL = inEllipse(u, v, 372, 700, 96, 74, -0.32);
  const headR = inEllipse(u, v, 660, 640, 96, 74, -0.32);
  const stemL = inRect(u, v, 452, 320, 34, 386);
  const stemR = inRect(u, v, 740, 260, 34, 386);
  // Beam joining the two stems, with a slight downward rake.
  const beam =
    u >= 452 && u <= 774 && v >= 260 + (774 - u) * 0.186 && v <= 348 + (774 - u) * 0.186;

  return headL || headR || stemL || stemR || beam;
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 1024 * 0.2237; // macOS "squircle" corner ratio, near enough

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let inside = 0;
      let note = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (inRoundedRect(fx, fy, SIZE, SIZE, radius)) inside++;
          if (isNote(fx * SS, fy * SS)) note++;
        }
      }
      const samples = SS * SS;
      const alpha = inside / samples;
      const noteMix = note / samples;

      const t = y / SIZE;
      // Slight ease so the gradient isn't a flat ramp.
      const e = t * t * (3 - 2 * t);
      let r = lerp(BG_TOP[0], BG_BOTTOM[0], e);
      let g = lerp(BG_TOP[1], BG_BOTTOM[1], e);
      let b = lerp(BG_TOP[2], BG_BOTTOM[2], e);

      r = lerp(r, FG[0], noteMix);
      g = lerp(g, FG[1], noteMix);
      b = lerp(b, FG[2], noteMix);

      const i = (y * SIZE + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// -- minimal PNG writer -----------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function writePng(pixels, size, file) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10-12: deflate / adaptive filtering / no interlace, all zero

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
const target = path.join(out, 'icon.png');
writePng(render(), SIZE, target);
console.log('wrote ' + target + ' (' + fs.statSync(target).size + ' bytes)');
