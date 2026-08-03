#!/usr/bin/env node
'use strict';

/**
 * Checks album grouping against every torrent actually in the library.
 *
 * The grouping rule is one regex and a segment index, which makes it very easy
 * to get subtly wrong in a way nobody notices until a record is split in half.
 * The case that proves it: Daft Punk's TRON Legacy is `CD1` and `CD2` — one
 * album — while Vice City's `Disc1 - V-Rock` and Kill Bill's `Vol.1` are
 * separate releases. A rule that gets Vice City right and TRON wrong looks
 * completely fine until you open TRON.
 *
 * Runs against the cached .torrent files, so it needs no network, no download
 * and no running app.
 *
 *   node scripts/album-grouping-check.js
 *   node scripts/album-grouping-check.js --list   # print every group it found
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const parseTorrent = require('parse-torrent');

const CACHE = path.join(
  os.homedir(),
  'Library/Application Support/2026-music-player/torrents'
);

// renderer/js/albums.js is a browser IIFE hanging things off window.MP, so it
// is evaluated here against a minimal stub rather than duplicated — a copy of
// the rule in the test would only ever verify itself.
function loadAlbums() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'albums.js'), 'utf8');
  const MEDIA = /\.(mp3|m4a|flac|ogg|oga|opus|aac|wav|mp4|m4v|webm|mkv|avi|mov)$/i;
  const IMAGE = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
  const win = {
    MP: {
      util: {
        isMediaFile: (f) => MEDIA.test(f.name || ''),
        isImageFile: (f) => IMAGE.test(f.name || ''),
      },
    },
  };
  // `MP` is passed separately because renderer modules reference it as a bare
  // global, the way they do in the browser — not via `window.MP`.
  // eslint-disable-next-line no-new-func
  new Function('window', 'MP', src)(win, win.MP);
  return win.MP.albums;
}

/**
 * What the real library must produce. Measured by hand from the torrent
 * contents; if the rule changes, these are what tell you whether it improved
 * or just moved the problem.
 */
const EXPECTED = [
  {
    match: /Aphex Twin/i,
    grouped: true,
    groups: 18,
    tracks: 221,
    // The torrent itself lists 2016 - Cheetah first and then restarts at 1992;
    // sorting is what puts the discography back in chronological order.
    firstGroup: '1992 - Selected Ambient Works 85-92',
    lastGroup: '2019 - London 14.09.2019 (EP)',
    note: '(2 discs) stays one group; chronological',
  },
  { match: /GTA V - All 15/i, grouped: true, groups: 15 },
  { match: /Vice City/i, grouped: true, groups: 7 },
  { match: /Kill Bill/i, grouped: true, groups: 3, note: 'Vol.1 and Vol.2 are separate' },
  { match: /TRON Legacy/i, grouped: false, groups: 1, note: 'CD1+CD2 are one album' },
  { match: /Flamagra/i, grouped: false, groups: 1 },
  { match: /Yasuke/i, grouped: false, groups: 1 },
  { match: /Big Mama/i, grouped: false, groups: 1 },
  { match: /Skrillex/i, grouped: false, groups: 1 },
];

async function main() {
  const showAll = process.argv.includes('--list');
  const albums = loadAlbums();

  let files;
  try {
    files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.torrent'));
  } catch (err) {
    console.error('No cached torrents at ' + CACHE + ' — open the app once first.');
    process.exit(2);
  }

  const seen = [];
  for (const f of files) {
    const parsed = await parseTorrent(fs.readFileSync(path.join(CACHE, f)));
    const torrent = { files: (parsed.files || []).map((x) => ({ name: x.name, path: x.path })) };
    seen.push({ name: parsed.name || f, result: albums.group(torrent) });
  }

  let failures = 0;
  console.log('');
  for (const exp of EXPECTED) {
    const hit = seen.find((s) => exp.match.test(s.name));
    if (!hit) {
      console.log('  SKIP  ' + exp.match + ' — not in the library cache');
      continue;
    }
    const r = hit.result;
    const tracks = r.groups.reduce((n, g) => n + g.indices.length, 0);
    const ok =
      r.grouped === exp.grouped &&
      r.groups.length === exp.groups &&
      (exp.tracks === undefined || tracks === exp.tracks) &&
      (exp.firstGroup === undefined || r.groups[0].name === exp.firstGroup) &&
      (exp.lastGroup === undefined || r.groups[r.groups.length - 1].name === exp.lastGroup);
    if (!ok) failures++;
    console.log(
      (ok ? '  PASS  ' : '  FAIL  ') +
        hit.name.slice(0, 44).padEnd(46) +
        'grouped=' + String(r.grouped).padEnd(6) +
        'groups=' + String(r.groups.length).padEnd(4) +
        'tracks=' + String(tracks).padEnd(5) +
        (ok ? (exp.note || '') : '  EXPECTED grouped=' + exp.grouped + ' groups=' + exp.groups +
          (exp.tracks ? ' tracks=' + exp.tracks : ''))
    );
    if (showAll) {
      r.groups.forEach((g) => console.log('          · ' + g.name + '  (' + g.indices.length + ')'));
    }
  }

  // A group with no tracks, or a track counted twice, would both render as a
  // visibly broken list — cheap to assert, and not covered by the counts above.
  for (const s of seen) {
    const all = s.result.groups.reduce((acc, g) => acc.concat(g.indices), []);
    if (new Set(all).size !== all.length) {
      console.log('  FAIL  ' + s.name.slice(0, 44) + ' — a file appears in two groups');
      failures++;
    }
    if (s.result.groups.some((g) => g.indices.length === 0)) {
      console.log('  FAIL  ' + s.name.slice(0, 44) + ' — empty group');
      failures++;
    }
    // Within an album, tracks must stay in file order — that is the running
    // order of the record, and nothing above should have disturbed it.
    for (const g of s.result.groups) {
      const sorted = g.indices.slice().sort((a, b) => a - b);
      if (String(sorted) !== String(g.indices)) {
        console.log('  FAIL  ' + s.name.slice(0, 44) + ' — "' + g.name + '" tracks out of file order');
        failures++;
      }
    }
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
