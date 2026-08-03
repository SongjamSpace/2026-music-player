'use strict';

/**
 * Decides *which* torrents exist, so the rest of the app can stop assuming all of
 * them do.
 *
 * Sits between main/index.js and TorrentService. The service keeps doing exactly
 * what it did — client options, activation, selection diffing, the shared progress
 * ticker, the metadata and modtimes caches. This owns lifecycle only.
 *
 * The problem it solves: every saved magnet was added at boot and no completed
 * torrent was ever destroyed, so a live WebTorrent existed for every album the user
 * had ever added. Each one costs a piece cache, up to `maxConns` wires, a bitfield
 * and an HTTP server, which is why footprint tracked library size rather than
 * activity. With the library index (main/library.js) able to answer "what albums
 * exist" and the file server (main/file-server.js) able to play the finished ones,
 * a torrent is only needed for content that is actually moving.
 *
 * -- states -------------------------------------------------------------------
 *
 *   downloading  live, counts against the cap, incomplete
 *   seeding      live, counts against the cap, complete
 *   idle         no torrent; complete on disk but no cached .torrent to wake from
 *   archived     no torrent; complete, and we hold metadata so waking is instant
 *                and works offline
 *   missing      no torrent; the files are not where the index says they are
 *
 * `idle` and `archived` are worth distinguishing precisely because of that last
 * clause: archived means we can go live again with no peers at all.
 *
 * -- policy -------------------------------------------------------------------
 *
 * Chosen with the user, not inferred:
 *
 *   - Incomplete albums auto-resume on launch, lazily, up to the cap — so a
 *     download in progress keeps progressing without the finished albums being live.
 *   - A newly completed album seeds for a grace window and then archives. That gives
 *     back at the moment it is most useful to the swarm, without a standing cost.
 *     Older albums seed only when asked.
 *   - Never archive an album that is actively uploading. Yanking a torrent mid-upload
 *     is antisocial and shows up as ratio damage, so the grace window extends while
 *     upload is live, up to a hard ceiling.
 */

/** Live torrents actively downloading. Beyond this, the rest queue. */
const MAX_LIVE_DOWNLOADING = 3;
/** Live torrents that are complete and seeding. LRU-evicted. */
const MAX_LIVE_SEEDING = 2;
/** How long a freshly completed album keeps seeding before archiving. */
const SEED_GRACE_MS = 30 * 60 * 1000;
/** Hard ceiling on grace extension while an upload is in flight. */
const SEED_GRACE_CEILING_MS = 2 * SEED_GRACE_MS;
/** Don't archive if we've seen upload traffic this recently. */
const UPLOAD_QUIET_MS = 60 * 1000;
/** How often to reconsider archiving. Coarse on purpose; nothing here is urgent. */
const SWEEP_MS = 60 * 1000;
/** Wait this long after first paint before waking anything. */
const RESUME_DELAY_MS = 2500;

/**
 * @param {object} deps
 * @param {import('./torrent-service').TorrentService} deps.service
 * @param {object} deps.library                  main/library.js
 * @param {function(string): Promise<any>} deps.wake
 *   Adds the torrent for this album id and resolves once it is live. Injected
 *   because adding needs the IPC send functions that only main/index.js has.
 * @param {function(): boolean=} deps.canRun     False when the library root is
 *   unavailable, in which case nothing should be woken at all.
 * @param {function(string): void=} deps.onArchived
 *   Called after an album goes to sleep. The renderer has to be told: it is still
 *   holding stream URLs for a server that has just been closed, and would otherwise
 *   keep pointing a media element at them.
 */
function createTorrentManager({ service, library, wake, canRun, onArchived }) {
  let sweepTimer = null;
  let resumeTimer = null;
  let stopped = false;

  /** publicId -> {completedAt, lastUploadAt} for albums in their grace window. */
  const grace = new Map();
  /** publicId -> timestamp it last went live, for LRU eviction of seeders. */
  const liveSince = new Map();
  /** In-flight wakes, so two callers can't add the same torrent twice. */
  const waking = new Map();

  function allowed() {
    return !stopped && (typeof canRun !== 'function' || canRun());
  }

  /** Live torrents, split by whether they are done. */
  function liveCounts() {
    const client = service.client;
    if (!client) return { downloading: 0, seeding: 0 };
    let downloading = 0;
    let seeding = 0;
    for (const t of client.torrents) {
      if (t.done) seeding++;
      else downloading++;
    }
    return { downloading, seeding };
  }

  /**
   * Bring an album's torrent up.
   *
   * Idempotent and de-duplicated: concurrent callers share one wake, because
   * webtorrent errors on adding an infohash it already has.
   */
  function ensureLive(publicId, reason) {
    if (!allowed()) return Promise.resolve(false);
    if (service.has(publicId)) return Promise.resolve(true);
    if (waking.has(publicId)) return waking.get(publicId);

    const record = library.get(publicId);
    if (!record) return Promise.resolve(false);

    const promise = Promise.resolve()
      .then(() => wake(publicId, record, reason))
      .then(() => {
        liveSince.set(publicId, Date.now());
        return true;
      })
      .catch((err) => {
        console.warn('[manager] could not wake', publicId, '(' + reason + ') -', err.message);
        return false;
      })
      .then((ok) => {
        waking.delete(publicId);
        return ok;
      });

    waking.set(publicId, promise);
    return promise;
  }

  /**
   * Take an album's torrent down, leaving the files alone.
   *
   * `destroyStore: false` is the whole point — this is not a removal, it is putting
   * the album back to sleep. The cached .torrent and modtimes stay, which is what
   * makes the next wake instant and offline.
   */
  async function archive(publicId, reason) {
    if (!service.has(publicId)) return false;
    try {
      await service.sleep(publicId);
    } catch (err) {
      console.warn('[manager] could not archive', publicId, '-', err.message);
      return false;
    }
    liveSince.delete(publicId);
    grace.delete(publicId);
    const record = library.get(publicId);
    if (record) {
      await library.patch(publicId, { state: record.complete ? 'archived' : 'idle' });
    }
    if (typeof onArchived === 'function') {
      try {
        onArchived(publicId);
      } catch (err) {
        console.warn('[manager] archive notification failed:', err.message);
      }
    }
    console.log('[manager] archived', publicId.slice(0, 8), '(' + reason + ')');
    return true;
  }

  /** Called by the service when an album finishes verifying. */
  function onComplete(publicId) {
    if (!grace.has(publicId)) {
      grace.set(publicId, { completedAt: Date.now(), lastUploadAt: 0 });
    }
  }

  /**
   * Whether this album can be put to sleep right now.
   *
   * Three reasons not to: it is still downloading, it is inside its grace window, or
   * it is mid-upload. The last one extends the window rather than blocking forever,
   * because a popular album would otherwise never archive.
   */
  function archivable(publicId, torrent, now) {
    if (!torrent.done) return false;

    const entry = grace.get(publicId);
    if (!entry) return true; // woken on demand, not freshly completed — no grace owed

    const age = now - entry.completedAt;
    if (age >= SEED_GRACE_CEILING_MS) return true;
    if (age < SEED_GRACE_MS) return false;

    // Past the grace window but still uploading: hold on, up to the ceiling.
    if (torrent.uploadSpeed > 0) entry.lastUploadAt = now;
    return now - entry.lastUploadAt >= UPLOAD_QUIET_MS;
  }

  /**
   * Periodic reconsideration. Deliberately the only place archiving is decided, so
   * the policy lives in one readable pass rather than scattered across callbacks.
   */
  async function sweep() {
    const client = service.client;
    if (!client || stopped) return;
    const now = Date.now();

    // Record upload activity for everything, before deciding anything: a torrent
    // that uploads only between sweeps must still count as active.
    for (const t of client.torrents) {
      const publicId = service.publicIdFor(t.infoHash);
      const entry = grace.get(publicId);
      if (entry && t.uploadSpeed > 0) entry.lastUploadAt = now;
    }

    const seeders = [];
    for (const t of client.torrents) {
      const publicId = service.publicIdFor(t.infoHash);
      if (!publicId) continue;
      if (!archivable(publicId, t, now)) continue;
      seeders.push({ publicId, since: liveSince.get(publicId) || 0 });
    }

    // Keep the most recently woken few seeding; archive the rest, oldest first.
    seeders.sort((a, b) => a.since - b.since);
    const keep = Math.max(0, MAX_LIVE_SEEDING);
    const toArchive = seeders.slice(0, Math.max(0, seeders.length - keep));
    for (const s of toArchive) {
      await archive(s.publicId, 'grace expired');
    }
  }

  /**
   * Wake the incomplete albums, up to the cap.
   *
   * After first paint, not during boot: the window opening should never wait on the
   * torrent engine, and this used to be the single most expensive thing at startup
   * because it also triggered SHA-1 re-verification of every partial album.
   */
  async function resumeDownloads() {
    if (!allowed()) return;
    const incomplete = library
      .list()
      .filter((a) => !a.complete && a.state !== 'missing')
      // Most nearly finished first: the fastest route to one fewer live torrent.
      .sort((a, b) => (b.presentBytes || 0) / (b.totalBytes || 1) - (a.presentBytes || 0) / (a.totalBytes || 1));

    const room = MAX_LIVE_DOWNLOADING - liveCounts().downloading;
    const batch = incomplete.slice(0, Math.max(0, room));
    if (!batch.length) return;

    console.log('[manager] resuming ' + batch.length + ' incomplete album(s)');
    for (const album of batch) {
      await ensureLive(album.id, 'auto-resume');
    }
    if (incomplete.length > batch.length) {
      console.log(
        '[manager] ' + (incomplete.length - batch.length) +
          ' more incomplete album(s) queued behind the live cap of ' + MAX_LIVE_DOWNLOADING
      );
    }
  }

  return {
    start() {
      stopped = false;
      if (!sweepTimer) {
        sweepTimer = setInterval(() => {
          sweep().catch((err) => console.warn('[manager] sweep failed:', err.message));
        }, SWEEP_MS);
        // Never the reason the process stays alive.
        if (sweepTimer.unref) sweepTimer.unref();
      }
      if (!resumeTimer) {
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          resumeDownloads().catch((err) => console.warn('[manager] resume failed:', err.message));
        }, RESUME_DELAY_MS);
        if (resumeTimer.unref) resumeTimer.unref();
      }
    },

    stop() {
      stopped = true;
      clearInterval(sweepTimer);
      clearTimeout(resumeTimer);
      sweepTimer = null;
      resumeTimer = null;
    },

    ensureLive,
    archive,
    onComplete,

    /** Explicit user action: seed this album now, and keep it up for a full window. */
    seed(publicId) {
      grace.set(publicId, { completedAt: Date.now(), lastUploadAt: Date.now() });
      return ensureLive(publicId, 'user asked to seed');
    },

    /** Forget everything tracked for an album that is being deleted. */
    forget(publicId) {
      grace.delete(publicId);
      liveSince.delete(publicId);
      waking.delete(publicId);
    },

    status() {
      const counts = liveCounts();
      return {
        live: counts,
        caps: { downloading: MAX_LIVE_DOWNLOADING, seeding: MAX_LIVE_SEEDING },
        inGrace: grace.size,
        waking: waking.size,
      };
    },

    /** Exposed for tests. */
    _sweep: sweep,
    _resumeDownloads: resumeDownloads,
    _archivable: archivable,
  };
}

module.exports = {
  createTorrentManager,
  MAX_LIVE_DOWNLOADING,
  MAX_LIVE_SEEDING,
  SEED_GRACE_MS,
  SEED_GRACE_CEILING_MS,
  UPLOAD_QUIET_MS,
};
