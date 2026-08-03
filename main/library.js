'use strict';

/**
 * The persistent library index: what albums exist, where their files are, and
 * whether they are complete.
 *
 * Why this exists: until now "the library" *was* the set of live WebTorrent
 * objects. Every cost that scales — piece caches, wires, bitfields, HTTP servers,
 * boot verification — scaled off that set, because the renderer had nowhere else
 * to get a file list from. An index the UI can read without a torrent being alive
 * is the precondition for not keeping them all alive.
 *
 * -- storage ----------------------------------------------------------------
 *
 *   <userData>/library/albums.jsonl      append-only log, one JSON record a line
 *   <userData>/library/albums.snapshot   compacted log, rewritten atomically
 *
 * Append-only, not a single JSON blob, and deliberately not electron-store.
 * `Store.set()` serialises and rewrites the *whole* file synchronously, and that
 * failure mode is already live in this app: renderer/js/store.js persists learned
 * durations through setPref into the same file as `magnets` and `prefs`. Putting a
 * multi-megabyte index there would mean every learned duration rewriting all of it.
 *
 * An append is one fs.appendFile of a few hundred bytes, so "album completed",
 * "duration learned" and "art extracted" are all cheap. It is also crash-safe by
 * construction — a torn final line is discarded on load — which matters for an app
 * whose entire crash apparatus exists because it has died mid-write before.
 *
 * Latest-wins on `id`: a record is always written whole, so the last line for an id
 * is the truth and earlier ones are history.
 *
 * -- interface ---------------------------------------------------------------
 *
 * Deliberately narrow — list/get/tracks/upsert/patch/remove — so the backend is one
 * file to replace. SQLite is the right answer at a million tracks; at ten thousand
 * the whole index is a few megabytes and in-memory Map lookups beat SQL round trips
 * for every query this app actually makes.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** Bumped when the record shape changes in a way that needs migrating. */
const RECORD_VERSION = 1;

/**
 * Compact once the log holds this many times more lines than there are albums.
 *
 * Purely an amortisation knob: every patch appends a line, so a heavily-edited
 * library accumulates history that only costs load time.
 */
const COMPACT_RATIO = 3;
/** Never bother compacting a log this short, whatever the ratio says. */
const COMPACT_MIN_LINES = 200;

/**
 * Also compact once the log passes this many bytes, regardless of line count.
 *
 * A line count alone is the wrong unit here, because records are not uniform: a
 * 242-track discography serialises to ~60 KB while a single is under 2 KB. Measured
 * on the real library, one launch appends ~200 KB across eleven albums — so a
 * line-count-only trigger would let the log reach several megabytes before firing,
 * and every one of those bytes is read at startup.
 */
const COMPACT_MAX_BYTES = 1024 * 1024;

const STATES = ['downloading', 'seeding', 'idle', 'archived', 'missing'];

/**
 * @param {object} record
 * @returns {boolean} whether this is a record we can use at all.
 *
 * Only `id` is truly required. Everything else is defaulted, because a record
 * written by an older version must not make the library unreadable.
 */
function isUsable(record) {
  return !!(record && typeof record === 'object' && typeof record.id === 'string' && record.id);
}

/** Fill in anything a record from an older version might be missing. */
function normalise(record) {
  const out = Object.assign({}, record);
  out.v = RECORD_VERSION;
  out.tracks = Array.isArray(out.tracks) ? out.tracks : [];
  out.state = STATES.indexOf(out.state) === -1 ? 'idle' : out.state;
  out.complete = !!out.complete;
  out.name = out.name || out.id;
  if (!out.art || typeof out.art !== 'object') out.art = { status: 'pending' };
  return out;
}

function createLibrary({ dir }) {
  const logPath = path.join(dir, 'albums.jsonl');
  const snapshotPath = path.join(dir, 'albums.snapshot');

  /** id -> record. Insertion order is not meaningful; callers sort. */
  const albums = new Map();
  let logLines = 0;
  let logBytes = 0;
  let loaded = false;
  /** Serialises appends and compaction so they cannot interleave. */
  let writeChain = Promise.resolve();

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Parse one file's worth of JSONL into the map.
   *
   * A malformed line is skipped rather than fatal. The last line is the one most
   * likely to be torn — a crash mid-append leaves a partial write — and losing the
   * newest record is recoverable, where refusing to load the library is not.
   *
   * @returns {number} lines consumed (including skipped ones).
   */
  function ingest(text) {
    if (!text) return 0;
    const lines = text.split('\n');
    let count = 0;
    let skipped = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      count++;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch (_) {
        skipped++;
        continue;
      }
      if (!isUsable(record)) {
        skipped++;
        continue;
      }
      if (record._deleted) albums.delete(record.id);
      else albums.set(record.id, normalise(record));
    }
    if (skipped) {
      console.warn('[library] skipped ' + skipped + ' unreadable line(s) — likely a torn write');
    }
    return count;
  }

  async function readIfPresent(file) {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[library] could not read ' + path.basename(file) + ':', err.message);
      }
      return null;
    }
  }

  /**
   * Load the snapshot, then replay the log over it.
   *
   * Order matters: the log holds everything appended since the snapshot was taken,
   * so it must be applied second for latest-wins to hold.
   */
  async function load() {
    if (loaded) return;
    ensureDir();
    albums.clear();
    const snapshot = await readIfPresent(snapshotPath);
    if (snapshot) ingest(snapshot);
    let log = await readIfPresent(logPath);

    // Repair a torn tail before anything appends to it.
    //
    // A crash mid-append leaves a partial line with no trailing newline. Skipping
    // it on read is not enough: the *next* append would concatenate onto the
    // fragment, producing one unparseable line and losing the new record too. So a
    // single torn write would quietly eat every record written after it. Truncate
    // to the last complete line instead.
    if (log && !log.endsWith('\n')) {
      const cut = log.lastIndexOf('\n');
      const repaired = cut === -1 ? '' : log.slice(0, cut + 1);
      console.warn('[library] repairing a torn final line in albums.jsonl');
      try {
        await fsp.writeFile(logPath, repaired);
        log = repaired;
      } catch (err) {
        console.warn('[library] could not repair the log:', err.message);
      }
    }

    logLines = log ? ingest(log) : 0;
    logBytes = log ? Buffer.byteLength(log) : 0;
    loaded = true;

    // A log that is already oversized on load — several launches' worth of appends
    // — is compacted now rather than waiting for the next write.
    if (shouldCompact()) {
      await enqueue(() => compact());
    }
  }

  function serialise(record) {
    return JSON.stringify(record) + '\n';
  }

  /** Queue a write so appends and compaction never interleave. */
  function enqueue(fn) {
    writeChain = writeChain.then(fn, fn);
    return writeChain;
  }

  async function append(record) {
    ensureDir();
    const line = serialise(record);
    await fsp.appendFile(logPath, line);
    logLines++;
    logBytes += Buffer.byteLength(line);
    if (shouldCompact()) await compact();
  }

  function shouldCompact() {
    if (logBytes > COMPACT_MAX_BYTES) return true;
    return logLines > COMPACT_MIN_LINES && logLines > albums.size * COMPACT_RATIO;
  }

  /**
   * Rewrite the snapshot from memory and truncate the log.
   *
   * Written to a temp file and renamed, because rename is atomic within a
   * filesystem: a crash mid-compaction leaves either the old snapshot plus the old
   * log, or the new snapshot — never a half-written index. The log is only
   * truncated *after* the rename succeeds, so the worst case is replaying records
   * that are already in the snapshot, which latest-wins makes harmless.
   */
  async function compact() {
    ensureDir();
    const tmp = snapshotPath + '.tmp';
    let body = '';
    for (const record of albums.values()) body += serialise(record);
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, snapshotPath);
    await fsp.writeFile(logPath, '');
    logLines = 0;
    logBytes = 0;
  }

  /**
   * Copy a record deeply enough that a caller cannot reach the stored one.
   *
   * `Object.assign({}, record)` is not enough: it shares the `tracks` array and the
   * track objects inside it, so a caller that adjusts a track it read would silently
   * edit the index — and the change would then be written out by the next unrelated
   * patch. The index is the UI's data source, so this has to be a real boundary.
   */
  function copy(record) {
    const out = Object.assign({}, record);
    out.tracks = record.tracks.map((t) => Object.assign({}, t));
    if (record.art) out.art = Object.assign({}, record.art);
    return out;
  }

  return {
    load,

    /** Every album. Returns copies, so callers cannot mutate the index in place. */
    list() {
      return [...albums.values()].map(copy);
    },

    get(id) {
      const record = albums.get(id);
      return record ? copy(record) : null;
    },

    tracks(id) {
      const record = albums.get(id);
      return record ? record.tracks.map((t) => Object.assign({}, t)) : [];
    },

    has(id) {
      return albums.has(id);
    },

    get size() {
      return albums.size;
    },

    /**
     * Replace a record wholesale.
     *
     * A write that would change nothing is skipped. This is not a micro-optimisation:
     * the index is refreshed from every live torrent as its metadata arrives, so a
     * launch that changes nothing was appending the whole library again — measured at
     * ~300 KB per launch across eleven albums, all of it read back at startup and all
     * of it identical. Comparing serialised records is cheap because they are small
     * and this happens once per album, not per tick.
     */
    upsert(record) {
      if (!isUsable(record)) return Promise.reject(new Error('library record needs an id'));
      const next = normalise(record);
      const current = albums.get(next.id);
      if (current && JSON.stringify(current) === JSON.stringify(next)) {
        return Promise.resolve();
      }
      albums.set(next.id, next);
      return enqueue(() => append(next));
    },

    /**
     * Merge fields into an existing record.
     *
     * Still appends the whole record, not a delta: replaying deltas would make load
     * order significant and a torn line ambiguous, and a few hundred bytes is not
     * worth that. Unknown ids are ignored rather than created — a patch for an album
     * that has been removed is a race, not a new album.
     */
    patch(id, fields) {
      const current = albums.get(id);
      if (!current) return Promise.resolve(false);
      const next = normalise(Object.assign({}, current, fields, { id }));
      // Same no-op guard as upsert: a patch that changes nothing must not grow the log.
      if (JSON.stringify(current) === JSON.stringify(next)) return Promise.resolve(true);
      albums.set(id, next);
      return enqueue(() => append(next)).then(() => true);
    },

    /**
     * Tombstone an album.
     *
     * A deletion has to be recorded rather than just dropped from memory, or the
     * next load would replay the album back out of the log.
     */
    remove(id) {
      if (!albums.has(id)) return Promise.resolve(false);
      albums.delete(id);
      return enqueue(() => append({ v: RECORD_VERSION, id, _deleted: true })).then(() => true);
    },

    /** Force a compaction — for tests, and after a bulk migration. */
    compact() {
      return enqueue(() => compact());
    },

    /** Wait for every queued write to land. Used on shutdown. */
    flush() {
      return enqueue(() => Promise.resolve());
    },

    stats() {
      return { albums: albums.size, logLines, logBytes, dir };
    },
  };
}

module.exports = { createLibrary, RECORD_VERSION, STATES, normalise };
