#!/usr/bin/env node
'use strict';

/**
 * Checks main/torrent-manager.js — the policy deciding which torrents are live.
 *
 * Worth testing precisely because it cannot be observed by hand: the seed grace
 * window is half an hour, so nobody sits and watches it, and getting it wrong is
 * either antisocial (yanking a torrent mid-upload, which costs ratio) or pointless
 * (never archiving anything, which is what this whole change exists to fix).
 *
 * Runs against fakes, so no Electron, no webtorrent, no network, no disk.
 *
 *   node scripts/manager-check.js
 */

const {
  createTorrentManager,
  MAX_LIVE_DOWNLOADING,
  SEED_GRACE_MS,
  SEED_GRACE_CEILING_MS,
  UPLOAD_QUIET_MS,
} = require('../main/torrent-manager');

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    '  ' + (ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(56) +
      (ok ? String(JSON.stringify(actual)).slice(0, 24)
          : 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
  );
}

/** Minimal stand-in for the bits of TorrentService the manager touches. */
function fakeService(torrents) {
  const live = new Map(torrents.map((t) => [t.infoHash, t]));
  return {
    client: { get torrents() { return [...live.values()]; } },
    has: (id) => live.has(id),
    publicIdFor: (hash) => hash,
    sleep: async (id) => { live.delete(id); },
    _live: live,
    _add: (t) => live.set(t.infoHash, t),
  };
}

function fakeLibrary(records) {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    get: (id) => (map.has(id) ? Object.assign({}, map.get(id)) : null),
    list: () => [...map.values()].map((r) => Object.assign({}, r)),
    has: (id) => map.has(id),
    patch: async (id, fields) => {
      if (!map.has(id)) return false;
      map.set(id, Object.assign({}, map.get(id), fields));
      return true;
    },
    _map: map,
  };
}

function torrent(infoHash, opts) {
  return Object.assign({ infoHash, done: false, uploadSpeed: 0 }, opts);
}

function album(id, opts) {
  return Object.assign(
    { id, name: id, complete: false, state: 'idle', totalBytes: 100, presentBytes: 0, tracks: [] },
    opts
  );
}

async function main() {
  console.log('');

  // -- the grace window ----------------------------------------------------
  {
    const service = fakeService([torrent('a', { done: true })]);
    const library = fakeLibrary([album('a', { complete: true })]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });

    const now = Date.now();
    const t = service._live.get('a');

    // Nothing in the grace map means it was woken on demand rather than freshly
    // completed, so no grace is owed.
    check('a woken seeder is archivable at once', mgr._archivable('a', t, now), true);

    mgr.onComplete('a');
    check('a freshly completed album is not archivable', mgr._archivable('a', t, now), false);
    check('...still not, one minute before the window ends',
      mgr._archivable('a', t, now + SEED_GRACE_MS - 60000), false);
    check('...archivable once the window has passed',
      mgr._archivable('a', t, now + SEED_GRACE_MS + 1), true);
  }

  // -- never yank an active upload ----------------------------------------
  {
    const service = fakeService([torrent('a', { done: true, uploadSpeed: 50000 })]);
    const library = fakeLibrary([album('a', { complete: true })]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    const now = Date.now();
    const t = service._live.get('a');
    mgr.onComplete('a');

    const past = now + SEED_GRACE_MS + 1;
    check('an actively uploading album is held past the window',
      mgr._archivable('a', t, past), false);

    // Upload stops; it becomes archivable only after the quiet period.
    t.uploadSpeed = 0;
    check('...still held immediately after upload stops',
      mgr._archivable('a', t, past + 1), false);
    check('...archivable once upload has been quiet',
      mgr._archivable('a', t, past + UPLOAD_QUIET_MS + 1), true);
  }

  // -- the ceiling stops a popular album seeding forever ------------------
  {
    const service = fakeService([torrent('a', { done: true, uploadSpeed: 999999 })]);
    const library = fakeLibrary([album('a', { complete: true })]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    const now = Date.now();
    const t = service._live.get('a');
    mgr.onComplete('a');
    check('a permanently uploading album still archives at the ceiling',
      mgr._archivable('a', t, now + SEED_GRACE_CEILING_MS + 1), true);
  }

  // -- an incomplete torrent is never archived ----------------------------
  {
    const service = fakeService([torrent('a', { done: false })]);
    const library = fakeLibrary([album('a')]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    check('a downloading album is never archivable',
      mgr._archivable('a', service._live.get('a'), Date.now() + SEED_GRACE_CEILING_MS * 10), false);
  }

  // -- auto-resume respects the cap ---------------------------------------
  {
    const woken = [];
    const albums = [];
    // Six incomplete albums at varying progress, plus two complete ones.
    for (let i = 0; i < 6; i++) {
      albums.push(album('dl' + i, { complete: false, totalBytes: 100, presentBytes: i * 10 }));
    }
    albums.push(album('done1', { complete: true, state: 'archived' }));
    albums.push(album('done2', { complete: true, state: 'archived' }));

    const service = fakeService([]);
    const library = fakeLibrary(albums);
    const mgr = createTorrentManager({
      service,
      library,
      wake: async (id) => {
        woken.push(id);
        service._add(torrent(id));
      },
    });

    await mgr._resumeDownloads();
    check('resume wakes only up to the live cap', woken.length, MAX_LIVE_DOWNLOADING);
    check('...and only incomplete albums', woken.every((id) => id.startsWith('dl')), true);
    // Most nearly finished first: the fastest route to one fewer live torrent.
    check('...most complete first', woken, ['dl5', 'dl4', 'dl3']);
  }

  // -- never archive what is playing --------------------------------------
  {
    // Archiving closes that torrent's HTTP server. Doing it under a track that is
    // streaming from it kills playback mid-song, and the media element reports
    // only a generic MediaError — which is how this surfaced: as a complaint that
    // a FLAC was an unsupported format, on a file that plays perfectly.
    const service = fakeService([torrent('a', { done: true })]);
    const library = fakeLibrary([album('a', { complete: true })]);
    let playing = 'a';
    const mgr = createTorrentManager({
      service, library, wake: async () => {}, isPlaying: (id) => id === playing,
    });
    const t = service._live.get('a');
    const past = Date.now() + SEED_GRACE_CEILING_MS + 1;

    mgr.onComplete('a');
    check('the album being played is never archivable', mgr._archivable('a', t, past), false);
    await mgr._sweep();
    check('...and the sweep leaves it alone', service.has('a'), true);

    playing = null;
    check('...archivable once playback moves on', mgr._archivable('a', t, past), true);
  }

  // -- a dormant album is reached even when the cap is full of live ones ---
  {
    // The regression this covers: `room` came from the live count while the
    // candidate list still included the live albums, sorted furthest-along first.
    // With the cap full of live torrents the batch was entirely albums that were
    // already up, so a dormant one was never reached however often resume ran.
    const woken = [];
    const albums = [
      album('live1', { complete: false, totalBytes: 100, presentBytes: 90 }),
      album('live2', { complete: false, totalBytes: 100, presentBytes: 80 }),
      album('dormant', { complete: false, totalBytes: 100, presentBytes: 13 }),
    ];
    const service = fakeService([torrent('live1'), torrent('live2')]);
    const library = fakeLibrary(albums);
    const mgr = createTorrentManager({
      service, library,
      wake: async (id) => { woken.push(id); service._add(torrent(id)); },
    });

    await mgr._resumeDownloads();
    check('a dormant album is woken past the live ones', woken, ['dormant']);
  }

  // -- the sweep retries a download that never came up --------------------
  {
    // Resuming used to happen once, 2.5s after launch. A wake that failed then
    // left the album dormant for the whole session with nothing to retry it.
    let attempt = 0;
    const service = fakeService([]);
    const library = fakeLibrary([album('flaky', { complete: false })]);
    const mgr = createTorrentManager({
      service, library,
      wake: async (id) => {
        attempt++;
        if (attempt === 1) throw new Error('swarm unreachable');
        service._add(torrent(id));
      },
    });

    await mgr._resumeDownloads();
    check('the first attempt fails', service.has('flaky'), false);
    // The backoff holds a failed album down, so an immediate sweep must not retry.
    await mgr._sweep();
    check('...the very next sweep backs off rather than hammering', attempt, 1);
    // Past the backoff window, the sweep picks it up without a relaunch.
    mgr._clearResumeBackoff();
    await mgr._sweep();
    check('...a later sweep retries and it comes up', service.has('flaky'), true);
  }

  // -- a missing album is not woken ---------------------------------------
  {
    const woken = [];
    const service = fakeService([]);
    const library = fakeLibrary([album('gone', { state: 'missing' })]);
    const mgr = createTorrentManager({
      service, library, wake: async (id) => { woken.push(id); },
    });
    await mgr._resumeDownloads();
    check('an album marked missing is never woken', woken.length, 0);
  }

  // -- nothing runs when the drive is unavailable -------------------------
  {
    const woken = [];
    const service = fakeService([]);
    const library = fakeLibrary([album('a')]);
    const mgr = createTorrentManager({
      service, library, canRun: () => false, wake: async (id) => { woken.push(id); },
    });
    await mgr._resumeDownloads();
    check('nothing is woken with the library unavailable', woken.length, 0);
    check('...and ensureLive refuses too', await mgr.ensureLive('a', 'test'), false);
  }

  // -- concurrent wakes are de-duplicated ---------------------------------
  {
    // webtorrent errors when adding an infohash it already has, so two callers
    // racing to wake the same album must share one add.
    let calls = 0;
    const service = fakeService([]);
    const library = fakeLibrary([album('a')]);
    const mgr = createTorrentManager({
      service,
      library,
      wake: async (id) => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        service._add(torrent(id));
      },
    });
    const [x, y, z] = await Promise.all([
      mgr.ensureLive('a', 'one'), mgr.ensureLive('a', 'two'), mgr.ensureLive('a', 'three'),
    ]);
    check('three concurrent wakes make one add', calls, 1);
    check('...and all three report success', [x, y, z], [true, true, true]);
    check('waking an already-live album is a no-op',
      await mgr.ensureLive('a', 'again'), true);
    check('...with still only one add', calls, 1);
  }

  // -- a wake that fails must not wedge the album -------------------------
  {
    let calls = 0;
    const service = fakeService([]);
    const library = fakeLibrary([album('a')]);
    const mgr = createTorrentManager({
      service, library,
      wake: async () => { calls++; throw new Error('swarm unreachable'); },
    });
    check('a failed wake reports false', await mgr.ensureLive('a', 'test'), false);
    // The in-flight entry has to be cleared, or the album could never be retried.
    check('a failed wake can be retried', await mgr.ensureLive('a', 'retry'), false);
    check('...and really did retry', calls, 2);
  }

  // -- unknown albums ------------------------------------------------------
  {
    const service = fakeService([]);
    const library = fakeLibrary([]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    check('waking an album that is not in the index fails cleanly',
      await mgr.ensureLive('nope', 'test'), false);
  }

  // -- archiving ------------------------------------------------------------
  {
    const archived = [];
    const service = fakeService([torrent('a', { done: true })]);
    const library = fakeLibrary([album('a', { complete: true, state: 'seeding' })]);
    const mgr = createTorrentManager({
      service, library, wake: async () => {}, onArchived: (id) => archived.push(id),
    });

    check('archive() takes the torrent down', await mgr.archive('a', 'test'), true);
    check('...the torrent is gone', service.has('a'), false);
    check('...the index records it as archived', library._map.get('a').state, 'archived');
    check('...and the renderer was told', archived, ['a']);
    check('archiving twice is a no-op', await mgr.archive('a', 'test'), false);
  }

  // -- an incomplete album archives to idle, not archived -----------------
  {
    const service = fakeService([torrent('a', { done: false })]);
    const library = fakeLibrary([album('a', { complete: false, state: 'downloading' })]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    await mgr.archive('a', 'test');
    // `archived` asserts we could wake instantly and offline; an incomplete album
    // that has been paused is only `idle`.
    check('an incomplete album archives to idle', library._map.get('a').state, 'idle');
  }

  // -- the sweep keeps the newest seeders -------------------------------
  {
    const now = Date.now();
    const service = fakeService([
      torrent('s1', { done: true }), torrent('s2', { done: true }),
      torrent('s3', { done: true }), torrent('s4', { done: true }),
    ]);
    const library = fakeLibrary([
      album('s1', { complete: true }), album('s2', { complete: true }),
      album('s3', { complete: true }), album('s4', { complete: true }),
    ]);
    const mgr = createTorrentManager({ service, library, wake: async () => {} });
    // All woken on demand, so no grace is owed and all are archivable.
    for (const id of ['s1', 's2', 's3', 's4']) await mgr.ensureLive(id, 'test');
    await mgr._sweep();
    const left = [...service._live.keys()].sort();
    check('the sweep trims seeders down to the cap', left.length, 2);
    check('...and an incomplete album would be untouched', mgr.status().live.downloading, 0);
    void now;
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all checks passed') + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
