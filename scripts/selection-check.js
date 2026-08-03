#!/usr/bin/env node
'use strict';

/**
 * Regression check for the playback-priority selection diff.
 *
 * The bug this guards against was invisible: `file.select(1)` paired with a
 * `file.deselect()` hardcoded to priority 0 never matched, so every play, seek
 * and shuffle appended another permanent entry to `torrent._selections` — an
 * array that gets re-sorted and walked on every piece update. Nothing surfaced
 * it; the app just got slower the longer you used it.
 *
 * Seeds a throwaway torrent from temp files so it runs offline in a second or
 * two, then hammers the same call the renderer makes.
 *
 *   node scripts/selection-check.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TorrentService } = require('../main/torrent-service');

const FILE_COUNT = 6;
const FILE_BYTES = 96 * 1024;

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   (' + detail + ')' : ''));
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-selection-check-'));
  const album = path.join(scratch, 'Test Album');
  fs.mkdirSync(album);
  for (let i = 0; i < FILE_COUNT; i++) {
    // Distinct content per file so they hash to different pieces.
    fs.writeFileSync(path.join(album, 'track-' + i + '.mp3'), Buffer.alloc(FILE_BYTES, i + 1));
  }

  const service = new TorrentService();
  service.setCacheDir(path.join(scratch, 'cache'));
  await service.start({ torrentPort: 0 });

  const id = 'a'.repeat(40); // stand-in public id; seedFromDisk aliases it
  await service.seedFromDisk(id, album, () => {}, () => {}, (err) => {
    console.error('seed error:', err.message);
  });

  const torrent = service._get(id);
  const selections = () => torrent._selections.length;

  // Baseline: webtorrent selects the whole torrent at priority 0 on metadata.
  const base = selections();
  console.log('\nseeded ' + torrent.files.length + ' files, ' + torrent.pieces.length + ' pieces');
  console.log('baseline selections: ' + base + '\n');

  // Simulate a long listening session: track changes, scrubbing, shuffling.
  for (let round = 0; round < 200; round++) {
    const current = round % FILE_COUNT;
    const next = (round + 1) % FILE_COUNT;
    service.setPlaybackPriorities(id, current, next, [0]);
  }
  check('selections bounded after 200 priority changes', selections() <= base + 3,
    selections() + ' selections, baseline ' + base);

  // Repeating an identical request must be a no-op, not another push.
  const before = selections();
  for (let i = 0; i < 50; i++) service.setPlaybackPriorities(id, 2, 3, [0]);
  check('identical repeated requests do not accumulate', selections() === before,
    before + ' -> ' + selections());

  // Every selection we own must be findable and removable by its own priority.
  service.setPlaybackPriorities(id, 4, 5, []);
  const state = service.selectionState.get(torrent.infoHash);
  check('tracked state matches what was asked for', state.size === 2,
    'tracked ' + state.size + ' entries');
  const priorities = [...state.values()].map((s) => s.priority).sort();
  check('priorities avoid FileStream\'s priority 1', !priorities.includes(1) && !priorities.includes(0),
    'priorities ' + priorities.join(','));

  // Clearing everything must return us to the baseline, not leave residue.
  service.setPlaybackPriorities(id, null, null, []);
  check('clearing all priorities returns to baseline', selections() === base,
    selections() + ' vs baseline ' + base);

  service.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
