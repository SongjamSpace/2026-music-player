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
/** Same element-wise compare albums.js uses, for asserting the order it produced. */
function compareKeys(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

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
    seen.push({ name: parsed.name || f, files: torrent.files, result: albums.group(torrent) });
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
    // Within an album, tracks must come out in the running order their filenames
    // describe. This used to assert plain file order; that was the bug — a torrent's
    // file order is whatever the packager's filesystem returned, and one album
    // arrived 03, 07, 08, 05, 01. Where the filenames make no claim, file order is
    // still what must survive.
    for (const g of s.result.groups) {
      const keys = g.indices.map((i) => {
        const f = s.files[i];
        const key = albums.trackOrderKey(f.name || f.path.split('/').pop());
        return { i, key, disc: albums.discNumber(f.path) };
      });
      const numbered = keys.filter((k) => k.key);
      // Only meaningful when the album is numbered at all — see NUMBERED_QUORUM.
      if (numbered.length >= Math.ceil(g.indices.length * (2 / 3))) {
        for (let n = 1; n < numbered.length; n++) {
          const prev = numbered[n - 1];
          const cur = numbered[n];
          const back =
            cur.disc < prev.disc ||
            (cur.disc === prev.disc && compareKeys(cur.key, prev.key) < 0);
          if (back) {
            console.log(
              '  FAIL  ' + s.name.slice(0, 40) + ' — "' + g.name + '" goes backwards: ' +
                prev.key.join('.') + ' then ' + cur.key.join('.')
            );
            failures++;
            break;
          }
        }
      } else {
        const sorted = g.indices.slice().sort((a, b) => a - b);
        if (String(sorted) !== String(g.indices)) {
          console.log(
            '  FAIL  ' + s.name.slice(0, 40) + ' — "' + g.name +
              '" was reordered despite having no track numbers'
          );
          failures++;
        }
      }
    }
  }

  // -- what counts as a track number ---------------------------------------
  //
  // The real library above proves the rule works on the releases at hand; these pin
  // the edges it must not get wrong, which no torrent here happens to exercise.
  {
    const k = (name) => JSON.stringify(albums.trackOrderKey(name));
    const cases = [
      // The ordinary shapes.
      ['03 Broke Zodiac.mp3', '[0,3]'],
      ['05. CIRKLON3.flac', '[0,5]'],
      ['01 - Xtal.flac', '[0,1]'],
      ['[07] Stride Rite.mp3', '[0,7]'],
      ['9) Something.mp3', '[0,9]'],
      // Disc-track, and vinyl sides.
      ['1-05 Title.flac', '[1,5]'],
      ['2_11 Title.flac', '[2,11]'],
      ['A1 Side Opener.mp3', '[1,1]'],
      ['B2 - Second.mp3', '[2,2]'],
      // A numeric field of its own, after the artist.
      ['Gang Gang Dance - 08 - Retina Riddim.mp3', '[0,8]'],
      ['Artist - Album - 12 - Title.mp3', '[0,12]'],
      // Everything below must make no claim at all. A wrong guess here reorders a
      // record that was already right, which is worse than leaving it alone.
      ['1984 Overture.flac', 'null'],          // four digits is a year, not a track
      ['2049 Blade.mp3', 'null'],
      ['Miles Davis - Take 5.mp3', 'null'],    // a number inside a field
      ['Blade Runner - 2049.mp3', 'null'],
      ['99Luftballons.mp3', 'null'],           // no separator: part of the word
      ['Untitled.mp3', 'null'],
      ['', 'null'],
      // Sanity: the number must lead, not merely appear.
      ['Symphony No. 5 - I. Allegro.flac', 'null'],
    ];
    for (const [name, expected] of cases) {
      const got = k(name);
      if (got !== expected) {
        console.log('  FAIL  trackOrderKey(' + JSON.stringify(name) + ') = ' + got + ', expected ' + expected);
        failures++;
      }
    }
    console.log('  PASS  ' + cases.length + ' track-number cases');

    // A disc folder under the album orders ahead of the track number, or the second
    // disc's 01 would interleave with the first disc's.
    const d = (p) => albums.discNumber(p);
    if (d('T/Album/CD2/01 x.flac') !== 2 || d('T/Album/01 x.flac') !== 0 || d('T/Album/Disc 3/x.flac') !== 3) {
      console.log('  FAIL  discNumber');
      failures++;
    } else {
      console.log('  PASS  disc folders are read from the path');
    }
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
