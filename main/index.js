const {
  app, BrowserWindow, Menu, crashReporter, dialog, ipcMain, nativeImage, session, shell,
} = require('electron');
const fs = require('fs');
// Async FS for anything that touches the download root: it lives on an external
// drive, and a sync call against a spun-down disk blocks the wire protocol.
// The crash-diagnostics paths stay sync on purpose — see writeSessionFlag.
const fsp = require('fs/promises');
const net = require('net');
const crypto = require('crypto');
const dgram = require('dgram');
const path = require('path');
const Store = require('electron-store');
const mm = require('music-metadata');
const {
  TorrentService,
  DEFAULT_DOWNLOAD_PATH,
  infoHashFromMagnet,
  AUDIO_RE,
} = require('./torrent-service');
const { createTrackers } = require('./trackers');
const { createPiecePolicy } = require('./piece-policy');
const { createFileServer } = require('./file-server');
const { createLibrary } = require('./library');
const { importFromMagnets, classifyTrackFile } = require('./library-import');
const { createTorrentManager } = require('./torrent-manager');
const { createArtwork } = require('./artwork');
const nat = require('./nat');
const netPath = require('./net-path');
const swarmProbe = require('./swarm-probe');

// Pin the data directory before anything reads it.
//
// Electron derives userData from the app name, which changes the moment a
// packaged build sets a productName — silently orphaning the library, prefs and
// cached .torrent files created while running from source. Naming it explicitly
// keeps `npm start` and the built .app pointing at the same folder.
app.setPath('userData', path.join(app.getPath('appData'), '2026-music-player'));

// -- crash safety net --------------------------------------------------------
//
// An uncaught throw in the main process takes the whole app down instantly:
// no macOS crash report (nothing crashed natively), no dialog, and stderr goes
// nowhere when launched from Finder. The result is an app that "just
// disappears" with no evidence at all, which is exactly what happened here.
//
// Two 1 Hz timers drive the torrent engine and both reach into WebTorrent
// internals; several of those — select/deselect/critical — throw outright on a
// torrent that was destroyed a moment earlier. Those call sites are guarded
// individually, but this is the backstop that makes a miss survivable and,
// more importantly, leaves a trace.

const CRASH_LOG = path.join(app.getPath('userData'), 'errors.log');

function recordError(kind, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  const line = '[' + new Date().toISOString() + '] ' + kind + '\n' + detail + '\n\n';
  console.error('[' + kind + ']', detail);
  try {
    fs.appendFileSync(CRASH_LOG, line);
  } catch (_) {
    /* logging must never be the thing that kills us */
  }
}

// Deliberately does NOT rethrow. A failed progress tick or a stale torrent
// handle is not a reason to drop playback and lose the user's session; it is a
// reason to write it down and carry on.
process.on('uncaughtException', (err) => recordError('uncaughtException', err));
process.on('unhandledRejection', (err) => recordError('unhandledRejection', err));

// -- native crash detection --------------------------------------------------
//
// The handlers above cannot see the failure that actually took this app down
// twice: a SIGSEGV inside utp-native, on the browser main thread. A segfault
// kills the process at the OS level — no JS runs, nothing is written, and from
// the user's side the app simply blinks out of existence.
//
// Two mechanisms are needed to have any evidence at all:
//
//  1. Crashpad writes a native minidump at the moment of the fault. It also
//     covers renderer and GPU process crashes, which don't reliably produce a
//     macOS .ips report the way a browser-process crash does.
//  2. A session sentinel, because a dump tells us *that* it died but nothing
//     about what the app was doing. The sentinel is rewritten periodically
//     with live state and deleted on clean quit, so finding one at startup
//     means the last session ended abnormally — and its contents are the last
//     known state before it did.
//
// Both are local-only. Nothing is uploaded anywhere.

crashReporter.start({ uploadToServer: false, compress: true });

const SESSION_FLAG = path.join(app.getPath('userData'), 'session.running');
const MAX_LOG_BYTES = 512 * 1024;
const STARTED_AT = new Date().toISOString();

// What the previous session was doing when it died, or null on a clean start.
// Read once at startup, before the flag is overwritten.
let lastAbnormalExit = null;

function readAbnormalExit() {
  let raw;
  try {
    raw = fs.readFileSync(SESSION_FLAG, 'utf8');
  } catch (_) {
    return null; // no flag — last quit was clean
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (_) {
    state = { note: 'sentinel unreadable' };
  }
  // Force Quit and a power cut leave the same trace as a segfault, so the
  // wording stays honest about what is actually known. A matching Crashpad
  // dump is what distinguishes them.
  state.dumps = latestDumps(state.started);
  state.diagnosis = state.dumps.length
    ? 'native crash — a minidump was written'
    : state.maxLagMs > 5000
      ? 'no crash dump, and the main thread was already blocking for up to ' +
        Math.round(state.maxLagMs / 1000) +
        's — most likely a freeze'
      : 'no crash dump — force quit, power loss, or a frozen event loop';
  recordError('previous session ended unexpectedly', new Error(JSON.stringify(state, null, 2)));
  return state;
}

/** Minidump filenames written since the given ISO timestamp. */
function latestDumps(sinceIso) {
  const dir = path.join(app.getPath('crashDumps'), 'completed');
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.dmp'))
      .filter((f) => fs.statSync(path.join(dir, f)).mtimeMs >= since)
      .slice(-3);
  } catch (_) {
    return [];
  }
}

const SESSION_TICK_MS = 30000;
// How late this timer runs is a direct measurement of main-thread blocking:
// nothing else can delay it. A freeze that never ends can't be recorded from
// inside the frozen process, but everything short of that shows up here — and
// a large value in the last record before an unexplained exit is the signature
// of an event loop that was already in trouble.
let lastTickAt = Date.now();
let maxLagMs = 0;

/**
 * Breadcrumbs for the next crash. Cheap enough to run on a timer, and the only
 * way a native fault leaves any application-level context behind.
 */
function writeSessionFlag() {
  const now = Date.now();
  const lag = now - lastTickAt - SESSION_TICK_MS;
  if (lag > maxLagMs) maxLagMs = lag;
  lastTickAt = now;

  let live = {};
  try {
    const d = torrentService.getDiagnostics();
    const client = torrentService.client;
    live = {
      utp: !!(d && d.client && d.client.utp),
      torrentPort: d && d.client ? d.client.torrentPort : null,
      downloadSpeed: d && d.client ? Math.round(d.client.downloadSpeed) : null,
      torrents: client ? client.torrents.length : 0,
      // Total wires is the number that matters for the utp-native fault: the
      // crash is socket churn, so a high count here next to a dump is the
      // signal.
      wires: client ? client.torrents.reduce((n, t) => n + ((t.wires && t.wires.length) || 0), 0) : 0,
      inboundNow: d ? d.inboundNow : null,
      inboundPeak: d ? d.inboundPeak : null,
      // Memory, because the failure this app actually exhibits is not a fault —
      // it is the main process growing until macOS starts compressing and
      // swapping its pages, at which point every IPC round trip can block on a
      // page-in and the app beachballs. A dump tells you nothing about that; a
      // heap trend across sessions does. rss understates a swapped process, so
      // heapUsed is recorded next to it as the V8-side number.
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  } catch (_) {
    /* diagnostics must never be able to break the thing recording the crash */
  }
  try {
    fs.writeFileSync(
      SESSION_FLAG,
      JSON.stringify(
        Object.assign(
          {
            pid: process.pid,
            started: STARTED_AT,
            updated: new Date().toISOString(),
            maxLagMs: Math.max(0, Math.round(maxLagMs)),
          },
          live
        )
      )
    );
  } catch (_) {
    /* ignore */
  }
}

function clearSessionFlag() {
  try {
    fs.unlinkSync(SESSION_FLAG);
  } catch (_) {
    /* already gone */
  }
}

/** Keeps errors.log from growing without bound; halves it when it gets big. */
function rotateCrashLog() {
  try {
    if (fs.statSync(CRASH_LOG).size <= MAX_LOG_BYTES) return;
    const text = fs.readFileSync(CRASH_LOG, 'utf8');
    fs.writeFileSync(CRASH_LOG, text.slice(-Math.floor(MAX_LOG_BYTES / 2)));
  } catch (_) {
    /* no log yet, or unwritable */
  }
}

const store = new Store();
const torrentService = new TorrentService();

/**
 * The persistent album index.
 *
 * Its own directory, not electron-store: see the note in main/library.js about
 * Store.set() rewriting the whole file synchronously, which this app already does
 * once per learned duration.
 */
const library = createLibrary({ dir: path.join(app.getPath('userData'), 'library') });

/**
 * Cover art, resized onto disk and served by URL.
 *
 * `nativeImage` and `parseFile` are injected rather than required inside the module,
 * so the resizing and tag-reading dependencies stay visible from here.
 */
const artwork = createArtwork({
  dir: path.join(app.getPath('userData'), 'artcache'),
  nativeImage,
  parseFile: (file, opts) => mm.parseFile(file, opts),
});

/**
 * Serves media and artwork that is already on disk, bypassing webtorrent.
 *
 * Path resolution is injected rather than imported so the server has no
 * dependency on the torrent engine — which is what lets scripts/range-check.js
 * exercise it without Electron, and what will let it keep working for archived
 * albums that have no live torrent at all.
 */
const fileServer = createFileServer({
  /**
   * Live torrent first, then the index.
   *
   * The index fallback is not a nicety — it is what makes archiving safe. An album
   * that has been put back to sleep has no torrent to ask, and without this every
   * archived album would become unplayable. Only tracks the index has verified are
   * resolvable, so a record cannot point the player at a file that is not there.
   */
  resolveMedia: (albumId, index) => {
    const live = torrentService.resolveMediaLocation(albumId, index);
    if (live) return live;

    const record = library.get(albumId);
    if (!record || !record.root) return null;
    const track = record.tracks.find((t, i) => (t.i != null ? t.i : i) === index);
    // `substituted` is a file the user put there themselves, in place of one the
    // release got wrong. It is playable and it is not what the torrent describes,
    // so it is served exactly like a verified track.
    if (!track || !(track.verified || track.substituted)) return null;
    // `length` lets the server tell us when what is on disk is not what the index
    // describes, using the stat it performs anyway.
    return { root: record.root, relPath: track.path, length: track.length || 0 };
  },

  /**
   * A track the index called verified is not on disk any more.
   *
   * The index is a cache of what the drive held when it was last written, and a
   * file can leave without telling us: deleted by hand, a folder renamed, a drive
   * remounted somewhere else. Nothing reconciled the two, so the file server went
   * on advertising a local URL that could only 404, and the player reported that as
   * an unspecified failure — with no way for the app to notice the obvious.
   *
   * Reacting to the 404 is enough, and it is free. A boot-time sweep would mean a
   * `stat` per track against USB on every launch, which is the kind of startup cost
   * the whole design exists to remove, and it would only find what the next play
   * attempt finds anyway.
   */
  onMediaMissing: (albumId, index) => {
    markTrackMissing(albumId, index).catch((err) =>
      console.warn('[library] could not record a missing track:', err.message)
    );
  },

  /**
   * The size of a media file on disk, reported by the server as it serves it.
   *
   * Two readings, and both matter. A size other than the release's, with no torrent
   * live, means the file was replaced from outside — a supported move, because a
   * release with one damaged track is fixed by dropping in a clean copy of that
   * track, and recording it is what stops the app repairing the user's file back to
   * the broken version. A size that matches again means the release's own file is
   * back, and a previous substitution no longer holds — without that the album would
   * refuse to seed forever on the strength of a file that is no longer there.
   *
   * With a torrent live, a mismatch is a download in progress and says nothing.
   */
  onMediaSize: (albumId, index, actualSize) => {
    if (torrentService.has(albumId)) return;
    reconcileTrackSize(albumId, index, actualSize).catch((err) =>
      console.warn('[library] could not record a track size:', err.message)
    );
  },

  /** Resized covers out of the art cache — see main/artwork.js. */
  resolveArt: (albumId, variant) => artwork.pathFor(albumId, variant),
});

/** Does this album hold a file the user replaced by hand? */
function hasSubstitutedTrack(record) {
  return !!(record && (record.tracks || []).some((t) => t.substituted));
}

/**
 * The one sentence every caller needs when it cannot bring such an album up.
 *
 * Worth stating rather than failing vaguely: the album is deliberately asleep, the
 * reason is a decision the user made, and there is a way back if they want the
 * release's own file again.
 */
const SUBSTITUTED_REFUSAL =
  'This album has a track you replaced by hand. Going back into the swarm would ' +
  'overwrite it with the release’s version, so the torrent stays off. Remove the ' +
  'album and re-add it if you want the original back.';

/**
 * Look at the tracks the index does not vouch for, and see what is on disk.
 *
 * Runs once at startup, before the window opens. The cost is bounded by the number
 * of *unverified* tracks rather than by the library, which is normally zero and was
 * three when this was written — nothing like the stat-everything sweep the design
 * deliberately avoids.
 *
 * It exists for one specific move: a release with a damaged track, where the fix is
 * to find a clean copy of that one file and drop it into the album folder. The app
 * has to notice and then get out of the way — serve the file, stop trying to
 * download it, and never let webtorrent overwrite it.
 *
 * Nothing is live yet at this point in boot, which is exactly what makes the length
 * comparison meaningful: no writer can be halfway through a file.
 */
async function reconcileUnverifiedTracks() {
  for (const album of library.list()) {
    // Undo a flag that cannot be true. `substituted` means "this was the release's
    // file and now it is the user's", so it is meaningless without `verified`, and an
    // earlier version of this pass set it on partially-downloaded files — which then
    // refuse to download, silently and forever. Self-healing rather than a migration
    // because the cost of leaving it is an album that never finishes.
    const bogus = album.tracks.filter((t) => t.substituted && !t.verified);
    if (bogus.length) {
      const cleaned = album.tracks.map((t) =>
        t.substituted && !t.verified ? Object.assign({}, t, { substituted: false }) : t
      );
      await library.patch(album.id, {
        tracks: cleaned,
        complete: cleaned.every((t) => t.verified || t.substituted),
        presentBytes: cleaned.reduce((n, t) => (t.verified || t.substituted ? n + (t.length || 0) : n), 0),
      });
      console.log(
        '[library]', album.name.slice(0, 40) + ':', 'cleared', bogus.length,
        'bogus replaced-by-hand flag(s) — those files are partial downloads'
      );
    }

    const record = library.get(album.id);
    if (!record || !record.root) continue;
    const pending = record.tracks.filter((t) => !t.verified && !t.substituted);
    if (!pending.length) continue;
    try {
      await fsp.access(record.root);
    } catch (_) {
      continue; // root unreachable — say nothing rather than guess
    }

    // Only an exact length match is acted on here. A mismatch is ambiguous at boot —
    // an unfinished download looks identical to a replaced file — and the ambiguity
    // is resolved later, at serve time, where the track's own history is known.
    const found = [];
    for (const track of pending) {
      let stat = null;
      try {
        const st = await fsp.stat(path.join(record.root, track.path));
        stat = { exists: st.isFile(), size: st.size };
      } catch (_) {
        stat = { exists: false, size: 0 };
      }
      // `false` for downloading: nothing is live during boot.
      if (classifyTrackFile(track, stat, false) === 'verified') found.push(track.i);
    }
    if (!found.length) continue;

    const tracks = record.tracks.map((t, i) =>
      found.indexOf(t.i != null ? t.i : i) === -1 ? t : Object.assign({}, t, { verified: true })
    );
    const present = tracks.reduce(
      (n, t) => (t.verified || t.substituted ? n + (t.length || 0) : n),
      0
    );
    const whole = tracks.every((t) => t.verified || t.substituted);
    await library.patch(album.id, {
      tracks: tracks,
      presentBytes: present,
      complete: whole,
      state: whole ? 'archived' : record.state,
    });

    console.log(
      '[library]', record.name.slice(0, 40) + ':', found.length,
      'track(s) confirmed on disk at the expected size'
    );
  }
}

/**
 * Record that a track on disk is the user's own file, not the release's.
 *
 * Deliberately does not correct `length` to the file's real size. That field is what
 * the torrent describes, and it is how this is recognised as a substitution at all
 * on the next launch; overwriting it would erase the evidence. `substitutedLength`
 * carries the actual size for anyone who wants it.
 */
async function reconcileTrackSize(albumId, index, actualSize) {
  const record = library.get(albumId);
  if (!record) return;
  const track = record.tracks.find((t, i) => (t.i != null ? t.i : i) === index);
  if (!track) return;

  const matches = (track.length || 0) === actualSize;
  if (matches && !track.substituted) return; // the ordinary case: nothing to say
  if (!matches && track.substituted) return; // already recorded

  if (matches) {
    // The release's own file is back — a re-download, or the user putting it back.
    // The substitution no longer describes anything, and leaving it would keep the
    // album out of the swarm on the strength of a file that is gone.
    const restored = record.tracks.map((t, i) =>
      (t.i != null ? t.i : i) === index
        ? Object.assign({}, t, { substituted: false, substitutedLength: undefined })
        : t
    );
    await library.patch(albumId, { tracks: restored });
    console.log('[library]', track.name, 'matches the release again — no longer treated as replaced');
    send('torrent-ready', albumToTorrentShape(library.get(albumId)));
    return;
  }

  // Only a file we previously vouched for. Without this an unfinished download would
  // be recorded as the user's own choice and then never completed — which is exactly
  // what happened when the boot pass judged on length alone.
  if (!track.verified) return;

  const tracks = record.tracks.map((t, i) =>
    (t.i != null ? t.i : i) === index
      ? Object.assign({}, t, { substituted: true, substitutedLength: actualSize })
      : t
  );
  const whole = tracks.every((t) => t.verified || t.substituted);
  await library.patch(albumId, {
    tracks: tracks,
    complete: whole,
    state: whole ? 'archived' : record.state,
  });
  console.log(
    '[library]', track.name, 'has been replaced by hand (' + actualSize + ' bytes, ' +
      'the release has ' + track.length + ') — it will be served as it is and never overwritten'
  );
  send('torrent-ready', albumToTorrentShape(library.get(albumId)));
}

/**
 * Record that a verified track has gone from disk, and start getting it back.
 *
 * Clearing `verified` is what stops the file server offering a URL that cannot
 * work; waking the torrent is what refills the gap. WebTorrent sees the file as
 * absent, so it downloads it and leaves the album's other 241 files alone.
 */
async function markTrackMissing(albumId, index) {
  const record = library.get(albumId);
  if (!record) return;
  const track = record.tracks.find((t, i) => (t.i != null ? t.i : i) === index);
  // A substituted file counts: if the user deletes their own replacement there is
  // nothing left to protect, so the album goes back to fetching the release's copy.
  if (!track || !(track.verified || track.substituted)) return;

  // An unplugged drive makes every track 404 at once. Marking them all unverified
  // would be a false diagnosis with a lasting cost: the flags persist, so a library
  // that is merely unmounted would come back claiming thousands of files need
  // re-downloading. A missing *file* under a root that is still there is the only
  // case this handles.
  if (!record.root) return;
  try {
    await fsp.access(record.root);
  } catch (_) {
    console.warn('[library] not marking', track.name, 'missing — its root is unreachable');
    return;
  }

  const tracks = record.tracks.map((t, i) =>
    (t.i != null ? t.i : i) === index
      ? Object.assign({}, t, { verified: false, substituted: false })
      : t
  );
  await library.patch(albumId, {
    tracks: tracks,
    complete: false,
    presentBytes: Math.max(0, (record.presentBytes || 0) - (track.length || 0)),
    state: 'downloading',
  });
  console.log('[library]', track.name, 'is gone from disk — re-fetching it');

  // Same reason as repair-track: the modtimes cache asserts the files are untouched
  // since they were verified, which is now false.
  torrentService.forgetCachedModtimes(albumId);
  if (record.realInfoHash) torrentService.forgetCachedModtimes(record.realInfoHash);
  if (torrentService.has(albumId)) await torrentManager.archive(albumId, 'a file went missing');

  const woke = await torrentManager.ensureLive(albumId, 'a verified file is missing');
  send('torrent-ready', albumToTorrentShape(library.get(albumId)));
  // Say what happened. Without this the renderer only sees a 404 and reports a
  // generic failure, while the app is already busy fixing it — which reads as
  // broken rather than as recovering.
  send('track-missing', { albumId: albumId, fileIndex: index, name: track.name, live: woke });
}

const piecePolicy = createPiecePolicy({
  service: torrentService,
  getPrefs: () => getPrefs(),
});

const DEFAULT_PREFS = {
  theme: 'midnight',
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  lastTorrentId: null,
  prefetch: true,
  readDurations: false,
  durations: {},
  dsp: {},
  // Null until first launch picks one — see resolveTorrentPort().
  torrentPort: null,
  uploadLimit: 1500000,
  // 'auto' follows the play-head buffer; the other two pin it for A/B testing.
  pieceStrategy: 'auto',
  showNetPanel: false,

  // An expectation the app checks reality against — NOT a control. The app
  // cannot choose an interface; see the routing note at the top of net-path.js.
  // null means "adopt whatever is detected", resolved once on first launch.
  expectedPath: null, // 'auto' | 'direct' | 'vpn' | 'vpn-preferred'
  homeNetwork: null, // fingerprint from netPath.fingerprint()
  peerEncryption: true, // restart-required in both directions
  // Opt-in, because utp-native segfaults under load — see the note at the
  // client options in torrent-service.js. Restart-required.
  enableUtp: false,
};

let mainWindow = null;
// Set when the preferred listen port was taken and we fell back to ephemeral,
// so the UI can explain why incoming connections are off.
let portFallback = null;

/**
 * False when the download root could not be confirmed — see checkLibraryRoot.
 *
 * Gates the lifecycle manager: with the drive missing, waking a torrent would have
 * webtorrent see 0% and start re-downloading the whole album.
 */
let libraryAvailable = true;

/**
 * The album the renderer is currently playing, or null.
 *
 * Kept here rather than asked of piecePolicy because it answers a different
 * question — piecePolicy cares where the play head is, the manager only needs to
 * know that this album must not be archived out from under an open stream.
 */
let playingAlbumId = null;

function getPrefs() {
  return Object.assign({}, DEFAULT_PREFS, store.get('prefs', {}));
}

function setPref(key, value) {
  const prefs = getPrefs();
  prefs[key] = value;
  store.set('prefs', prefs);
  return prefs;
}

/**
 * A fixed listen port, chosen once per install and then kept.
 *
 * Not ephemeral: a random port can't be port-forwarded, and every peer that
 * learned our address through DHT or PEX is unable to reconnect after a
 * restart. Not 51413 either — that's Transmission's well-known port and the
 * first thing a traffic shaper looks for. Random-per-install in the dynamic
 * range gives a stable address without a recognisable fingerprint.
 */
function preferredTorrentPort() {
  const saved = getPrefs().torrentPort;
  if (Number.isInteger(saved) && saved > 1024 && saved < 65534) return saved;
  const port = 49160 + Math.floor(Math.random() * 15000);
  setPref('torrentPort', port);
  return port;
}

function canBindTcp(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function canBindUdp(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      try {
        socket.close();
      } catch (_) {
        /* already gone */
      }
      resolve(false);
    });
    socket.bind(port, () => socket.close(() => resolve(true)));
  });
}

/**
 * Check the port is actually free before handing it to WebTorrent.
 *
 * This matters more than it looks: WebTorrent treats a failed listen as a fatal
 * client error and destroys itself, so a single EADDRINUSE takes down every
 * torrent with a "client is destroyed" for anything you try afterwards. A
 * second copy of the app — or anything else on that port — would otherwise
 * leave the player silently unable to download at all.
 *
 * Falling back to an ephemeral port loses inbound connectivity for the session,
 * which is a real cost, but it is not remotely the same cost as no downloads.
 */
async function resolveTorrentPort() {
  const preferred = preferredTorrentPort();
  const free =
    (await canBindTcp(preferred)) &&
    (await canBindUdp(preferred)) &&
    (await canBindUdp(preferred + 1));
  if (free) return { port: preferred, preferred, fellBack: false };

  console.warn(
    '[torrent] port ' + preferred + ' is in use (another copy of the app?) — ' +
    'falling back to a random port for this session; incoming connections will not work'
  );
  return { port: 0, preferred, fellBack: true };
}

/**
 * Force permissive CORS on the per-torrent stream servers.
 *
 * Web Audio silently outputs nothing for a CORS-tainted media element, so the
 * equaliser needs the elements loaded with `crossorigin="anonymous"`. WebTorrent's
 * server does send an ACAO header, but only echoes the request's own origin — and
 * this renderer is a file:// page, so that origin is the string "null". Rather than
 * depend on Chromium accepting a literal `null` match, pin it to `*`, which is
 * always valid for an uncredentialed request.
 *
 * Filtering happens in JS rather than via a urls match pattern because Chrome
 * patterns can't express "any port", and every torrent server gets a random one.
 */
function installStreamCorsHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.indexOf('http://127.0.0.1:') !== 0) return callback({});

    const headers = Object.assign({}, details.responseHeaders);
    // Strip any existing variant first: two conflicting ACAO headers fail outright.
    Object.keys(headers).forEach((key) => {
      if (/^access-control-allow-(origin|methods|headers)$/i.test(key)) delete headers[key];
    });
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    headers['Access-Control-Allow-Headers'] = ['Range'];
    headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges'];
    callback({ responseHeaders: headers });
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0d0d0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Passed synchronously so the renderer can set the theme before first paint.
      // An inline bootstrap script is impossible under `script-src 'self'`, and
      // reading the theme over async IPC would guarantee a flash.
      additionalArguments: ['--mp-theme=' + getPrefs().theme],
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (!app.isPackaged && process.env.MP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Mirror renderer console output into the terminal. Off by default; the
  // renderer is otherwise a black box unless DevTools happens to be open.
  if (!app.isPackaged && process.env.MP_DEBUG === '1') {
    const levels = ['debug', 'info', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      const where = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
      console.log(`[renderer:${levels[level] || level}] ${message}${where}`);
    });
  }

  // Always on, packaged included. A dead renderer is a blank window with the
  // audio cut off and no clue why — indistinguishable from "the app crashed".
  // Reloading gets playback controls back; the reason lands in the log either
  // way. `clean-exit` is the normal teardown on quit, so it isn't a failure.
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer] gone:', details.reason, 'exitCode:', details.exitCode);
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return;
    mainWindow.reload();
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[renderer] unresponsive — main thread blocked');
  });
  mainWindow.webContents.on('responsive', () => {
    console.error('[renderer] responsive again');
  });
}

function buildMenu() {
  const cmd = (command) => () => send('menu-command', command);
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add Magnet…', accelerator: 'CmdOrCtrl+N', click: cmd('add-magnet') },
        { type: 'separator' },
        { label: 'Reveal Downloads in Finder', click: cmd('reveal-downloads') },
        { label: 'Reveal Torrent in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('reveal-torrent') },
        // No accelerator: Cmd+Delete is "delete to line start" inside the
        // magnet field, and a menu accelerator would swallow it there.
        { label: 'Remove Selected Torrent', click: cmd('remove-torrent') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Playback',
      // Space and the Cmd+Arrow pairs are handled in the renderer instead of as
      // accelerators here: a menu accelerator fires even while a text field has
      // focus, which would make Space and Cmd+Left unusable in the magnet field.
      submenu: [
        { label: 'Play / Pause', click: cmd('play-pause') },
        { label: 'Next Track', click: cmd('next') },
        { label: 'Previous Track', click: cmd('prev') },
        { type: 'separator' },
        { label: 'Audio Effects…', accelerator: 'CmdOrCtrl+E', click: cmd('dsp') },
        { type: 'separator' },
        { label: 'Mute', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('mute') },
        { label: 'Shuffle', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('shuffle') },
        { label: 'Cycle Repeat', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('repeat') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Cycle Theme', accelerator: 'CmdOrCtrl+Alt+T', click: cmd('cycle-theme') },
        { label: 'Find in Tracks', accelerator: 'CmdOrCtrl+F', click: cmd('focus-filter') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: cmd('shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * First-run resolution of `expectedPath`, plus the initial probe.
 *
 * The expectation is adopted from what is actually detected, and it is done
 * here in main rather than in the renderer so that a launch on a broken network
 * can't bake in a wrong expectation from a stale UI read. Written through
 * setPref so it survives, and only ever set once.
 */
async function initNetPath() {
  if (getPrefs().expectedPath == null) {
    const egress = await netPath.detectEgress();
    const adopted = egress && egress.tunnel ? 'vpn-preferred' : 'direct';
    setPref('expectedPath', adopted);
    netPath.setExpected(adopted);
    console.log('[net-path] first run — expecting ' + adopted);
  }
  await netPath.refreshFingerprint();
  await netPath.preflight();
}

// userData is already pinned at the top of this file, so it is safe to read
// before 'ready'.
const trackers = createTrackers({
  cacheDir: app.getPath('userData'),
  log: (msg) => console.log(msg),
});

app.whenReady().then(async () => {
  rotateCrashLog();
  // Must read before the new flag is written, or this session overwrites the
  // evidence from the one that died.
  lastAbnormalExit = readAbnormalExit();
  writeSessionFlag();
  setInterval(writeSessionFlag, SESSION_TICK_MS).unref();

  installStreamCorsHeaders();
  torrentService.setCacheDir(path.join(app.getPath('userData'), 'torrents'));

  // Before the torrent client, so the very first file list can already carry local
  // URLs. Failing to listen is not fatal — every use site falls back to streaming
  // through webtorrent, which is what happened before this existed.
  try {
    await fileServer.start();
    torrentService.localUrlFor = (publicId, index) => fileServer.mediaUrl(publicId, index);
  } catch (err) {
    recordError('local file server', err);
  }

  const listen = await resolveTorrentPort();
  portFallback = listen.fellBack ? listen.preferred : null;
  await torrentService.start({
    torrentPort: listen.port,
    uploadLimit: getPrefs().uploadLimit,
    secure: getPrefs().peerEncryption !== false,
    utp: getPrefs().enableUtp === true,
    trackers,
  });

  // Completion is the point at which webtorrent has verified every piece, so it is
  // the only moment the index can honestly mark tracks verified — and the moment the
  // lifecycle manager starts its seed grace window.
  torrentService.onTorrentComplete = (publicId) => {
    torrentManager.onComplete(publicId);
    indexFromLiveTorrent(publicId).catch((err) =>
      console.warn('[library] could not record completion for', publicId, '-', err.message)
    );
  };

  // A destroyed client is unrecoverable in place, so say so plainly rather than
  // letting the user watch 0 B/s and conclude the swarms are dead.
  torrentService.onClientError = (info) => {
    recordError('torrent client error', new Error(info.message));
    send('torrent-error', {
      message: info.fatal
        ? 'The torrent engine stopped (' + info.message + '). Restart the app to resume downloads.'
        : 'Torrent engine warning: ' + info.message,
    });
  };

  netPath.setExpected(getPrefs().expectedPath);
  netPath.setHome(getPrefs().homeNetwork);
  // Fire and forget, same reasoning as nat.open(): nothing about showing a
  // window should wait on a network probe.
  initNetPath().catch((err) => console.error('[net-path] startup:', err.message));

  // Fire and forget: torrents added before this lands still get the cached or
  // builtin list, and the refreshed one persists for next launch.
  trackers.refresh();

  // Also fire and forget. A silent gateway takes seconds to time out, and there
  // is nothing about opening a window that should wait on the router.
  // Pointless on an ephemeral port: it changes every launch, so the mapping
  // would be stale before anyone could use it. nat.open() additionally skips
  // the router entirely when traffic egresses a tunnel.
  if (listen.port) {
    nat
      .open({ torrentPort: listen.port, dhtPort: listen.port + 1 })
      .then((s) => send('nat-status', s))
      .catch((err) => console.error('[nat] unexpected:', err.message));
  }

  piecePolicy.start();

  const savedPath = store.get('downloadPath');
  // Named for what it checks — the *root directory* — not `library`, which is the
  // index itself and lives at module scope.
  const libraryRoot = checkLibraryRoot(savedPath);
  if (savedPath && libraryRoot.ok) {
    torrentService.setDownloadPath(savedPath);
  }

  const savedMagnets = store.get('magnets', []);

  // Before the window, so the first thing the renderer asks for is already warm.
  // Cheap enough to justify blocking: measured at 1,000 albums / 10,000 tracks the
  // whole index is 1.2 MB and loads in ~5ms.
  try {
    await artwork.load();
  } catch (err) {
    // A missing or unreadable manifest just means re-extracting on demand.
    console.warn('[artwork] could not load cache manifest:', err.message);
  }

  try {
    await library.load();
    // Only when the drive is actually there. Importing against a missing root would
    // stat every track as absent and record the entire library as empty — which is
    // the same class of mistake as letting webtorrent re-download it.
    if (libraryRoot.ok && library.size < savedMagnets.length) {
      // Reconstructs records from the cached .torrent files plus a stat per file —
      // no network, no peers, no piece verification. Additive and idempotent, so it
      // is safe on every launch and safe to re-run after a partial failure.
      const imported = await importFromMagnets({
        library,
        magnets: savedMagnets,
        cacheDir: path.join(app.getPath('userData'), 'torrents'),
        downloadRoot: torrentService.getDownloadPath(),
        now: new Date().toISOString(),
      });
      if (imported.added) {
        console.log('[library] imported ' + imported.added + ' album(s) into the index');
      }
      if (imported.unresolved.length) {
        console.log(
          '[library] ' + imported.unresolved.length +
            ' magnet(s) have no cached metadata yet — they import once a peer supplies it'
        );
      }
    }
    // Reconcile states left over from the previous session.
    //
    // `downloading` and `seeding` both describe a *live* torrent, and nothing is live
    // yet — the process just started. A crash, or a quit while an album was seeding,
    // leaves those states recorded, and they would then be wrong for the whole
    // session: the UI would offer to resume a download that is already running, or
    // claim an album is seeding when nothing is.
    for (const album of library.list()) {
      if (album.state === 'downloading' || album.state === 'seeding') {
        await library.patch(album.id, { state: album.complete ? 'archived' : 'idle' });
      }
    }
    if (libraryRoot.ok) await reconcileUnverifiedTracks();
  } catch (err) {
    // The index is additive at this point: the app still works from live torrents
    // without it, so a failure here must not stop the window opening.
    recordError('library index', err);
  }

  libraryAvailable = libraryRoot.ok;

  buildMenu();
  createWindow();
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      // If the drive is missing, say so and add nothing at all.
      if (!libraryRoot.ok) {
        send('library-unavailable', libraryRoot);
        return;
      }

      // Nothing is added here any more.
      //
      // This used to send every saved magnet to the renderer, which added them all
      // back — so the whole library went live on every launch, and with it every
      // piece cache, wire and HTTP server. It was also the single most expensive
      // thing at startup, because a partial torrent cannot use the modtimes cache
      // (webtorrent requires a modtime for *every* file) and therefore re-hashed
      // itself in full: ~7.2 GB of SHA-1 off an external drive, on the same thread
      // as the UI, every time the app opened.
      //
      // The renderer now renders from the index, and the lifecycle manager wakes
      // only what is actually needed — starting with incomplete albums, after paint.
      torrentManager.start();

      // Magnets with no index record yet have never had metadata from a peer, so
      // there is nothing to render for them. Those still need adding to make any
      // progress at all.
      const unresolved = savedMagnets.filter((m) => {
        const hash = infoHashFromMagnet(m);
        return hash && !library.has(hash);
      });
      if (unresolved.length) {
        console.log('[library] adding ' + unresolved.length + ' magnet(s) still awaiting metadata');
        send('restore-magnets', unresolved);
      }
    });
  }
});

// -- shutdown --------------------------------------------------------------
//
// Releasing the router mappings is asynchronous, so teardown can't happen
// inline in 'window-all-closed' the way it used to. Leaked mappings aren't
// catastrophic — they expire with their TTL — but they accumulate in the
// router's table across restarts, and small routers do run out.

const SHUTDOWN_TIMEOUT_MS = 3000;
let shuttingDown = false;

async function shutdown() {
  piecePolicy.stop();
  torrentManager.stop();
  // A router that stops answering mid-unmap must never be able to wedge quit.
  await Promise.race([
    nat.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  try {
    torrentService.destroy();
  } catch (err) {
    console.warn('[shutdown] torrent teardown:', err.stack || err.message);
  }
  // After the torrents, so an in-flight read cannot be cut off mid-write, and in
  // its own try: a failure here must not be able to skip clearSessionFlag() below,
  // or the next launch reports a crash that did not happen.
  try {
    await fileServer.stop();
  } catch (err) {
    console.warn('[shutdown] file server:', err.message);
  }
  // Index writes are queued, so a record upserted moments before quit could still
  // be in flight. Its own try, for the same reason as above.
  try {
    await library.flush();
  } catch (err) {
    console.warn('[shutdown] library flush:', err.message);
  }
  // Last thing, and only on the path that ran teardown: the absence of this
  // file is the entire signal that the previous session exited cleanly.
  clearSessionFlag();
}

app.on('before-quit', (event) => {
  if (shuttingDown) return; // second pass — let Electron finish the quit
  shuttingDown = true;
  event.preventDefault();
  console.log('[shutdown] releasing port mappings…');
  // Never leave this un-caught: if teardown rejects, the app hangs with no
  // window and no way to quit but Force Quit.
  shutdown()
    .catch((err) => console.warn('[shutdown] failed:', err.message))
    .then(() => {
      console.log('[shutdown] done');
      app.quit();
    });
});

app.on('window-all-closed', () => {
  app.quit();
});

// -- keeping the index current ---------------------------------------------
//
// The index has to agree with what is on disk without being the thing that reads
// the disk on every tick. Two write points are enough:
//
//   1. metadata arrives — we finally know the file list, so the record can exist
//   2. the torrent finishes — every track is verified by webtorrent itself
//
// Nothing writes per progress tick. A record that says `partial` while the download
// runs is correct, and the next launch's import re-stats anyway.

/**
 * Write (or refresh) an album record from a live torrent.
 *
 * Preferred over the cached-.torrent import when a torrent is live, because it also
 * captures `realInfoHash` — the hash webtorrent actually knows the album by, which
 * differs from the library id whenever the album was seeded from disk. Once boot
 * stops adding torrents, the index is the only place that mapping can come from.
 */
async function indexFromLiveTorrent(publicId, magnetUri) {
  const files = torrentService.getTorrentFiles(publicId);
  if (!files || !files.length) return;
  const root = torrentService.getTorrentPath(publicId);
  const meta = torrentService.getTorrentMeta(publicId);
  const existing = library.get(publicId);

  const complete = !!(meta && meta.done);
  const tracks = files.map((f, i) => {
    const prior = existing && existing.tracks[i];
    return {
      i: i,
      path: f.path,
      name: f.name,
      length: f.length,
      // Sticky: a file webtorrent has verified once does not become unverified
      // because a later snapshot was taken mid-download.
      verified: complete || !!(prior && prior.verified),
      // Carried forward deliberately. This is a statement about a file the user
      // replaced by hand, and a live torrent knows nothing about it — dropping it
      // here would silently re-enter the album into "needs downloading" and let
      // webtorrent overwrite their file with the bytes they replaced.
      substituted: !!(prior && prior.substituted),
      repairedAt: prior ? prior.repairedAt : undefined,
      mtimeMs: prior ? prior.mtimeMs : null,
      dur: prior ? prior.dur : null,
    };
  });

  await library.upsert({
    id: publicId,
    // Only when it really differs from the id — see aliasInfoHash.
    realInfoHash: torrentService.aliasInfoHash(publicId) || (existing && existing.realInfoHash) || null,
    magnetURI: magnetUri || (existing && existing.magnetURI) || (meta && meta.magnetURI) || null,
    name: (meta && meta.name) || (existing && existing.name) || publicId,
    root: root || (existing && existing.root) || null,
    state: complete ? 'seeding' : 'downloading',
    totalBytes: (meta && meta.length) || tracks.reduce((n, t) => n + t.length, 0),
    presentBytes: complete
      ? tracks.reduce((n, t) => n + t.length, 0)
      : (existing && existing.presentBytes) || 0,
    pieceLength: (meta && meta.pieceLength) || (existing && existing.pieceLength) || 0,
    numPieces: (meta && meta.numPieces) || (existing && existing.numPieces) || 0,
    complete: complete,
    tracks: tracks,
    art: (existing && existing.art) || { status: 'pending' },
    addedAt: (existing && existing.addedAt) || new Date().toISOString(),
    completedAt: complete
      ? (existing && existing.completedAt) || new Date().toISOString()
      : (existing && existing.completedAt) || null,
  });
}

/**
 * Add a magnet, whether it is new or being woken from the index.
 *
 * Shared by the add-torrent handler and the lifecycle manager's `wake`, so a woken
 * album goes through exactly the same activation, reporting and indexing as a fresh
 * one — there is no second code path to keep in step.
 */
function addMagnet(magnetUri, { persist } = {}) {
  const hash = infoHashFromMagnet(magnetUri);
  if (hash && torrentService.has(hash)) {
    return Promise.resolve({ success: true, pending: false, duplicate: true, id: hash });
  }

  const onTorrentReady = (data) => {
    // `state` comes from the index, which the service knows nothing about. Sent
    // alongside `live` so the UI can distinguish "downloading" from "seeding" without
    // inferring it from progress.
    const record = library.get(data.id);
    send('torrent-ready', Object.assign({}, data, {
      state: data.done ? 'seeding' : 'downloading',
      // Carry the index's own view when it has one and the torrent isn't done yet, so
      // a resumed partial reads as `downloading` rather than flipping about.
      complete: record ? record.complete : !!data.done,
    }));
    if (persist !== false) {
      const magnets = store.get('magnets', []);
      if (!magnets.includes(magnetUri)) {
        magnets.push(magnetUri);
        store.set('magnets', magnets);
      }
    }
    // Metadata has arrived, so the index can finally describe this album. This is
    // also the path that resolves a magnet the import had to skip for want of a
    // cached .torrent.
    indexFromLiveTorrent(data.id, magnetUri).catch((err) =>
      console.warn('[library] could not index', data.id, '-', err.message)
    );
  };
  const onProgress = (data) => send('torrent-progress', data);
  const onError = (err) => send('torrent-error', { message: err.message || String(err) });

  return torrentService
    .add(magnetUri, onTorrentReady, onProgress, onError)
    .then(() => ({ success: true, pending: true, id: hash }));
}

/**
 * Owns which torrents are live. See main/torrent-manager.js for the policy.
 *
 * `wake` is injected rather than the manager importing the service, because adding a
 * torrent needs the IPC senders and the index write that only this file has.
 */
const torrentManager = createTorrentManager({
  service: torrentService,
  library,
  canRun: () => libraryAvailable,
  // Never take down the album the user is listening to. A track streaming from the
  // torrent has an open connection to that torrent's HTTP server, and archiving
  // closes it mid-track: the media element reports a bare MediaError, which the
  // renderer used to render as "this format isn't supported".
  isPlaying: (publicId) => publicId === playingAlbumId,
  wake: (publicId, record) => {
    // Backstop for a hand-replaced track. Bringing this torrent up would have
    // webtorrent hash the album, find the piece covering that file failing — because
    // it is not the release's file — and download over it. There is no per-file way
    // to opt out that also lets the album report itself complete, so the album stays
    // asleep and every caller gets a clear refusal instead.
    if (hasSubstitutedTrack(record)) {
      return Promise.reject(new Error('album contains a hand-replaced track'));
    }
    // The magnet is what `add()` takes; the cached .torrent it prefers internally is
    // what makes waking instant and offline. An album with neither cannot be woken.
    const magnetUri = record.magnetURI ||
      (record.realInfoHash ? 'magnet:?xt=urn:btih:' + record.realInfoHash : null) ||
      'magnet:?xt=urn:btih:' + publicId;
    // persist:false — it is already in `magnets`, and re-appending on every wake
    // would be pointless churn on a synchronously-rewritten store file.
    return addMagnet(magnetUri, { persist: false });
  },
  onArchived: (publicId) => {
    // Re-send the album in its index shape. This deliberately reuses `torrent-ready`
    // rather than adding a channel: the store already merges that payload and
    // replaces the file list wholesale, which is exactly what has to happen — the
    // stream URLs it currently holds point at a server that no longer exists.
    const record = library.get(publicId);
    if (record) send('torrent-ready', albumToTorrentShape(record));
  },
});

ipcMain.handle('add-torrent', async (event, magnetUri) => addMagnet(magnetUri));

/** Explicit user action, from the album menu. */
ipcMain.handle('seed-album', async (event, albumId) => {
  if (hasSubstitutedTrack(library.get(albumId))) return { error: SUBSTITUTED_REFUSAL };
  const ok = await torrentManager.seed(albumId);
  return { success: ok };
});

/** Explicit user action: resume a download that is queued behind the live cap. */
ipcMain.handle('resume-album', async (event, albumId) => {
  if (hasSubstitutedTrack(library.get(albumId))) return { error: SUBSTITUTED_REFUSAL };
  const ok = await torrentManager.ensureLive(albumId, 'user asked to resume');
  return { success: ok };
});

/**
 * The library the renderer renders from: every album, with live detail where there
 * is a live torrent.
 *
 * This is the join that lets the UI stop depending on torrents being alive. Before
 * the index, this returned only live torrents — which was fine when boot added
 * everything, and would now show a nearly empty library. Index records supply the
 * name, the file list and what is on disk; a live torrent overrides with real peer
 * counts, speeds and progress.
 *
 * Shape is unchanged from the live-only version on purpose. The renderer's store,
 * album grouping, track list and queue all read this shape, and changing it and the
 * lifecycle at the same time would make any regression hard to attribute.
 */
function albumToTorrentShape(record) {
  const tracks = record.tracks || [];
  return {
    id: record.id,
    name: record.name,
    magnetURI: record.magnetURI || null,
    files: tracks.map((t, i) => {
      const index = t.i != null ? t.i : i;
      return {
        name: t.name,
        path: t.path,
        length: t.length,
        // No torrent, so no torrent stream. A verified track still plays, straight
        // off disk — which is the entire point.
        streamURL: null,
        localURL: t.verified || t.substituted ? fileServer.mediaUrl(record.id, index) : null,
        // Surfaced so the UI can say the album is not purely the release any more,
        // which is the reason it never seeds and never re-downloads.
        substituted: !!t.substituted,
        type: 'application/octet-stream',
      };
    }),
    // Byte-accurate rather than a track ratio, so a part-downloaded album reads the
    // same as it does while live.
    progress: record.totalBytes ? (record.presentBytes || 0) / record.totalBytes : 0,
    numPeers: 0,
    downloadSpeed: 0,
    timeRemaining: null,
    downloaded: record.presentBytes || 0,
    length: record.totalBytes || 0,
    done: !!record.complete,
    // What the index knows about each file, in the shape the store treats as
    // authoritative — so an archived album shows correct per-track progress with no
    // torrent to ask.
    fileProgress: tracks.map((t) => ({
      progress: t.verified || t.substituted ? 1 : 0,
      downloaded: t.verified || t.substituted ? t.length : 0,
    })),
    state: record.state,
    live: false,
  };
}

ipcMain.handle('get-torrents', () => {
  const live = torrentService.getTorrents();
  const liveById = new Map(live.map((t) => [t.id, t]));

  const out = [];
  for (const record of library.list()) {
    const liveEntry = liveById.get(record.id);
    if (liveEntry) {
      liveById.delete(record.id);
      out.push(Object.assign({ state: record.state }, liveEntry, { live: true }));
    } else {
      out.push(albumToTorrentShape(record));
    }
  }
  // Anything live but not yet indexed — a magnet added moments ago whose metadata has
  // not arrived. Must still appear, or adding a torrent would look like nothing
  // happened.
  for (const remaining of liveById.values()) {
    out.push(Object.assign({ state: 'downloading' }, remaining, { live: true }));
  }
  return out;
});

/**
 * The library as recorded on disk, independent of any live torrent.
 *
 * Album headers only — no track lists. A thousand albums of headers is a few tens of
 * kilobytes over IPC, where the full index with tracks is megabytes, and the UI only
 * needs tracks for whatever is open. `get-library-tracks` fetches those on demand.
 */
ipcMain.handle('get-library', () => {
  return library.list().map((a) => ({
    id: a.id,
    name: a.name,
    state: a.state,
    complete: a.complete,
    totalBytes: a.totalBytes,
    presentBytes: a.presentBytes || 0,
    trackCount: a.tracks.length,
    art: a.art,
    addedAt: a.addedAt || null,
    completedAt: a.completedAt || null,
  }));
});

ipcMain.handle('get-library-tracks', (event, albumId) => {
  const record = library.get(albumId);
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    root: record.root,
    complete: record.complete,
    tracks: record.tracks.map((t, i) => ({
      i: t.i != null ? t.i : i,
      name: t.name,
      path: t.path,
      length: t.length,
      verified: !!(t.verified || t.substituted),
      substituted: !!t.substituted,
      dur: t.dur != null ? t.dur : null,
      // Only for tracks actually present, so the renderer never points a media
      // element at a file that is not there.
      localURL:
        t.verified || t.substituted ? fileServer.mediaUrl(record.id, t.i != null ? t.i : i) : null,
    })),
  };
});

// -- cover art -------------------------------------------------------------
//
// Extracted once, resized, cached on disk and handed to the renderer as a URL. See
// main/artwork.js for why: the previous version shipped base64 data URLs, so the same
// unresized image existed as an inflated string here, again in the renderer, and
// again as a decoded bitmap in Chromium — roughly 10 MB per album, permanently.
//
// The reply is an explicit status, not a nullable URL, because the two "no art right
// now" cases are different and conflating them was a real bug: `null` meant both
// "nothing has finished downloading yet, ask again" and "looked, and there is no art,
// stop asking", while the renderer treated it as terminal. Art therefore never
// appeared for any album still downloading when its tile first rendered.
//
//   pending  nothing readable yet; ask again later
//   none     looked, and there is no art; terminal
//   ok       `url` points at the cached file

/**
 * Where an album's images and complete audio files are, for extraction.
 *
 * Uses the index rather than a live torrent, so art works for archived albums — which
 * after the lifecycle manager is most of the library.
 */
function artSourcesFor(albumId) {
  const record = library.get(albumId);
  if (!record || !record.root) {
    // No index record yet, but possibly a live torrent — a magnet added moments ago.
    const audioPaths = torrentService.getCompleteAudioPaths(albumId, 3);
    return { id: albumId, imagePaths: [], audioPaths };
  }

  const imagePaths = [];
  const audioPaths = [];
  for (const track of record.tracks) {
    if (!track.verified && !track.substituted) continue;
    const abs = path.join(record.root, track.path);
    if (IMAGE_ART_RE.test(track.name)) imagePaths.push(abs);
    else if (AUDIO_RE.test(track.name) && audioPaths.length < 3) audioPaths.push(abs);
  }
  return { id: albumId, imagePaths, audioPaths };
}

const IMAGE_ART_RE = /\.(jpg|jpeg|png|webp|gif|avif|bmp)$/i;

ipcMain.handle('get-album-art', async (event, albumId) => {
  const result = await artwork.get(artSourcesFor(albumId));
  if (result.status !== 'ok') return { status: result.status };

  // Version in the URL, so replacing a cover busts the cache rather than being
  // masked by it — which is what lets the server mark art immutable.
  return {
    status: 'ok',
    url: fileServer.artUrl(albumId, 'hero', result.version),
    thumbUrl: fileServer.artUrl(albumId, 'thumb', result.version),
  };
});

// -- library root safety ---------------------------------------------------
//
// The library lives on an external drive, and losing sight of it is the most
// destructive thing that can happen to this app — far worse than a crash.
//
// `/Volumes/My Book/...` is an ordinary path when the drive is not mounted:
// macOS will happily let a stub directory be created there. WebTorrent then sees
// every torrent at 0%, and starts re-downloading the entire library over the
// swarm — 11.4 GB, on a metered connection, silently overwriting nothing but
// wasting everything. Checking `existsSync` alone does not catch it, because
// after the first bad launch the stub directory *does* exist.
//
// So the root has to identify itself. A marker file holding a random id, written
// once and compared on every launch, distinguishes "my library" from "some empty
// directory that happens to sit at the same path". It also survives the drive
// being renamed or remounted at a different mount point, which a volume UUID
// from `diskutil` would not, and it needs no subprocess.

const LIBRARY_MARKER = '.mp-library-id';

/**
 * @param {string} root
 * @param {boolean=} adopt  True when the user has just picked this folder in a
 *   dialog. That is an explicit act, so an empty directory is a legitimate
 *   choice — someone moving the library to a fresh drive — rather than the
 *   unmounted-volume signature it would be at launch.
 * @returns {{ok: boolean, reason?: string, path?: string}}
 *   `ok: false` means: add nothing, seed nothing, and tell the user. Never
 *   create the directory — creating it is the bug.
 */
function checkLibraryRoot(root, adopt) {
  if (!root) return { ok: true }; // never configured; the default path applies
  const markerPath = path.join(root, LIBRARY_MARKER);
  const expected = store.get('libraryId') || null;

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    return { ok: false, reason: 'missing', path: root };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'missing', path: root };

  let marker = null;
  try {
    marker = fs.readFileSync(markerPath, 'utf8').trim() || null;
  } catch (_) {
    /* no marker yet */
  }

  // First run against a root we have never stamped. Adopt it rather than
  // refusing — but only if it is genuinely ours: an empty directory at this path
  // with torrents already in the library is exactly the unmounted-drive case.
  if (!expected) {
    if (!marker) {
      const hasLibrary = (store.get('magnets', []) || []).length > 0;
      let looksPopulated = false;
      try {
        looksPopulated = fs.readdirSync(root).some((n) => !n.startsWith('.'));
      } catch (_) {
        /* unreadable — treat as empty */
      }
      // An unstamped, empty root while the library is non-empty is the
      // unmounted-drive signature. Unless the user just chose it by hand.
      if (!adopt && hasLibrary && !looksPopulated) {
        return { ok: false, reason: 'empty', path: root };
      }
      marker = crypto.randomUUID();
      try {
        fs.writeFileSync(markerPath, marker);
      } catch (err) {
        // A read-only or absent volume. Do not proceed on a guess.
        return { ok: false, reason: 'unwritable', path: root, detail: err.message };
      }
    }
    store.set('libraryId', marker);
    return { ok: true };
  }

  // Stamped in prefs but the marker is not there. Could be our drive with the
  // dotfile deleted, or could be a stub at the same path — and we cannot tell.
  // Refusing is recoverable (re-pick the folder in Settings); proceeding risks
  // re-downloading the entire library, so this errs toward refusing.
  if (!marker) return { ok: false, reason: 'unstamped', path: root };
  if (marker !== expected) return { ok: false, reason: 'mismatch', path: root };
  return { ok: true };
}

// -- local-folder fallback -------------------------------------------------

/**
 * Directory listing of the download root, cached for a few seconds.
 *
 * The library lives on an external drive, and `readdirSync` against a spun-down
 * USB disk blocks for seconds — on the same thread as the wire protocol, the
 * piece picker and every IPC reply. So: async, and not re-read once per torrent
 * when the user clicks through several unresolved albums in a row.
 *
 * The TTL is short because the point of this scan is to notice files the user
 * put there by hand.
 */
const ROOT_LISTING_TTL_MS = 5000;
let rootListing = { root: null, at: 0, dirs: null };

async function listDownloadRoot() {
  const root = torrentService.getDownloadPath();
  const now = Date.now();
  if (rootListing.root === root && rootListing.dirs && now - rootListing.at < ROOT_LISTING_TTL_MS) {
    return rootListing.dirs;
  }
  let dirs = [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    /* root missing or unreadable — treat as empty, never as an error */
  }
  rootListing = { root, at: now, dirs };
  return dirs;
}

/** Locate the download folder for a torrent we have no metadata for. */
async function findLocalFolder(torrentId) {
  const magnet = store.get('magnets', []).find((m) => infoHashFromMagnet(m) === torrentId);
  if (!magnet) return null;
  const dn = /[?&]dn=([^&]+)/.exec(magnet);
  if (!dn) return null;

  let name;
  try {
    name = decodeURIComponent(dn[1].replace(/\+/g, ' '));
  } catch (_) {
    return null;
  }

  const root = torrentService.getDownloadPath();
  try {
    const st = await fsp.stat(path.join(root, name));
    if (st.isDirectory()) return path.join(root, name);
  } catch (_) {
    /* no exact match — fall through to the loose one */
  }

  // The folder on disk comes from the .torrent's name, which can differ from
  // the magnet's display name, so fall back to a loose match.
  //
  // Entities are dropped, not decoded. A scraped `dn=` carries them where the
  // folder has the real character — `Isn&rsquo;t` against `Isn’t` — and since this
  // comparison discards punctuation anyway, removing the whole `&…;` leaves
  // `isntitnow` on both sides. Decoding would need an entity table here purely to
  // throw the result away.
  const normalise = (s) =>
    s.toLowerCase().replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/g, '').replace(/[^a-z0-9]/g, '');
  const target = normalise(name);
  const hit = (await listDownloadRoot()).find((dirName) => {
    const n = normalise(dirName);
    return n === target || n.startsWith(target.slice(0, 24)) || target.startsWith(n.slice(0, 24));
  });
  return hit ? path.join(root, hit) : null;
}

/**
 * How many real audio tracks are in a folder.
 *
 * `._name.mp3` files are excluded deliberately. The library sits on exFAT, which
 * has no native extended attributes, so macOS writes every xattr into an
 * AppleDouble sidecar next to the real file — same extension, a few hundred
 * bytes. Counting those doubled the reported track count on that drive, and a
 * folder of nothing but sidecars would have read as "already downloaded".
 */
async function countMedia(folder) {
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    let n = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith('._')) continue;
      if (AUDIO_RE.test(e.name)) n++;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

ipcMain.handle('check-local-folder', async (event, torrentId) => {
  if (torrentService.hasMetadata(torrentId)) return { available: false };
  const folder = await findLocalFolder(torrentId);
  if (!folder) return { available: false };
  const trackCount = await countMedia(folder);
  return trackCount > 0
    ? { available: true, path: folder, name: path.basename(folder), trackCount }
    : { available: false };
});

ipcMain.handle('load-from-disk', async (event, torrentId) => {
  const folder = await findLocalFolder(torrentId);
  if (!folder) return { error: 'No matching folder in your downloads' };
  try {
    const onProgress = (data) => send('torrent-progress', data);
    const result = await torrentService.seedFromDisk(
      torrentId,
      folder,
      (data) => send('torrent-ready', data),
      onProgress,
      (err) => send('torrent-error', { message: err.message || String(err) })
    );
    return { success: true, fileCount: result.fileCount };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('remove-torrent', async (event, torrentId, destroyStore) => {
  // Capture the real infohash before removal drops the alias, or piecePolicy's
  // per-torrent memos have nothing to key off.
  const realHash = torrentService.realInfoHash(torrentId);
  await torrentService.remove(torrentId, destroyStore);
  const hash = String(torrentId).toLowerCase();
  const magnets = store.get('magnets', []);
  // Match on the parsed infohash, not a substring of the whole URI — a `dn=` display
  // name could otherwise contain the hash and take an unrelated magnet with it.
  store.set('magnets', magnets.filter((m) => infoHashFromMagnet(m) !== hash));

  // Everything else in this process keyed by torrent id. None of this was being
  // released: removing an album left its artwork, its debounce timers and its
  // piece-policy memos behind for the life of the session.
  await artwork.forget(torrentId);
  clearTimeout(priorityTimers.get(torrentId));
  priorityTimers.delete(torrentId);
  priorityLast.delete(torrentId);
  piecePolicy.forget(realHash || hash);
  torrentManager.forget(torrentId);
  // Tombstoned, not just dropped: without a recorded deletion the album would be
  // replayed out of the log on the next load.
  await library.remove(torrentId);
});

ipcMain.handle('get-download-path', () => torrentService.getDownloadPath());

ipcMain.handle('set-download-path', (event, dir) => {
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
  // Choosing a folder is an explicit act, so re-stamp: this root is now the
  // library, whatever the old marker said. Without this, switching drives would
  // trip the mismatch guard on the next launch.
  store.delete('libraryId');
  const library = checkLibraryRoot(dir, true);
  if (!library.ok) send('library-unavailable', library);
  return torrentService.getDownloadPath();
});

ipcMain.handle('get-default-download-path', () => DEFAULT_DOWNLOAD_PATH);

ipcMain.handle('choose-download-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose download folder',
    defaultPath: torrentService.getDownloadPath(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use Folder',
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  torrentService.setDownloadPath(dir);
  store.set('downloadPath', dir);
  return { canceled: false, path: dir };
});

ipcMain.handle('get-prefs', () => getPrefs());

ipcMain.handle('set-pref', (event, key, value) => {
  const prefs = setPref(key, value);
  // The upload cap is a live knob — webtorrent rebuilds the throttle group on
  // the fly, so there's no reason to make the user restart for it. The listen
  // port is not: changing it means rebinding sockets and remapping the router.
  if (key === 'uploadLimit') torrentService.setUploadLimit(value);
  // Pure display state — the app cannot act on an expectation, only check it.
  if (key === 'expectedPath') netPath.setExpected(value);
  // peerEncryption is deliberately absent: enableSecure() is one-way, so it
  // cannot be applied live in either direction. The Settings row says so.
  return prefs;
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Null on a clean start. Non-null means the last session did not shut down —
// the UI says so once, because an app that silently vanishes and comes back
// pretending nothing happened is the worst version of this bug.
ipcMain.handle('get-last-crash', () => lastAbnormalExit);

ipcMain.handle('open-logs-folder', () => {
  shell.showItemInFolder(CRASH_LOG);
  return true;
});

// -- playback priority -----------------------------------------------------
//
// The renderer fires this on play, next, seek, seekTo, shuffle and repeat, so a
// scrub drag produces a burst of them. Each one costs a full re-sort of the
// selection list plus an interest recalculation that loops every piece against
// every wire — on the same thread as the torrent engine. Collapse identical
// requests outright and trail the rest.

const PRIORITY_DEBOUNCE_MS = 250;
const priorityTimers = new Map();
const priorityLast = new Map();

function schedulePriority(torrentId, current, next, pinned) {
  const signature = JSON.stringify([current, next, pinned || []]);
  if (priorityLast.get(torrentId) === signature) return;
  priorityLast.set(torrentId, signature);

  clearTimeout(priorityTimers.get(torrentId));
  priorityTimers.set(
    torrentId,
    setTimeout(() => {
      priorityTimers.delete(torrentId);
      torrentService.setPlaybackPriorities(torrentId, current, next, pinned);
    }, PRIORITY_DEBOUNCE_MS)
  );
}

/**
 * Carries the play head as well as the track indices. The position is what lets
 * the readahead window follow the listener instead of sitting at the start of
 * the file; it arrives at ~1 Hz off the media element's timeupdate.
 */
ipcMain.handle('set-playback-state', (event, state) => {
  if (!state || state.torrentId == null) {
    playingAlbumId = null;
    piecePolicy.setPlaybackState(null);
    return;
  }
  // The manager consults this before archiving — see the note on `isPlaying`.
  playingAlbumId = state.torrentId;

  // Playing something we do not have yet is the main reason to wake a torrent.
  //
  // A track already on disk needs no torrent at all — the file server reads it, and
  // the index tells that server where it is. But a track that is not verified can
  // only come from the swarm, so the album has to go live. Fire-and-forget: playback
  // has already started against whatever source it had, and waking only makes the
  // bytes arrive.
  if (!torrentService.has(state.torrentId)) {
    const record = library.get(state.torrentId);
    const track = record && record.tracks[state.fileIndex];
    if (record && (!track || !(track.verified || track.substituted))) {
      torrentManager.ensureLive(state.torrentId, 'playback needs undownloaded bytes');
    }
  }

  schedulePriority(state.torrentId, state.fileIndex, state.nextFileIndex, state.pinned);
  piecePolicy.setPlaybackState({
    torrentId: state.torrentId,
    fileIndex: state.fileIndex,
    nextFileIndex: state.nextFileIndex,
    currentTime: Number(state.currentTime) || 0,
    duration: Number(state.duration) || 0,
  });
});

/**
 * On demand only — this opens real TCP connections to real peers, so it runs
 * when the user asks and never on a timer.
 */
ipcMain.handle('probe-swarm', async (event, torrentId) => {
  let info = torrentService.getSwarmProbeInput(torrentId);
  // An album that is asleep is the normal case now, not an error — most of the
  // library has no live torrent at any given moment. Asking about its swarm is an
  // explicit user action, so bring it up and then answer, rather than reporting
  // "not loaded", which read as a fault and left the user with nothing to do.
  if (!info) {
    if (!library.get(torrentId)) return { error: 'That album is not in the library.' };
    if (hasSubstitutedTrack(library.get(torrentId))) return { error: SUBSTITUTED_REFUSAL };
    const woke = await torrentManager.ensureLive(torrentId, 'reachability check');
    if (!woke) {
      return {
        error: 'Could not bring this torrent up — the library folder may be unavailable.',
      };
    }
    info = torrentService.getSwarmProbeInput(torrentId);
    if (!info) return { error: 'That torrent came up without metadata — try again in a moment.' };
  }
  try {
    return await swarmProbe.probe(info.infoHash, {
      trackers: info.trackers,
      knownPeers: info.knownPeers,
    });
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('set-active-torrent', (event, torrentId) => {
  torrentService.setActiveTorrent(torrentId);
});

ipcMain.handle('get-diagnostics', (event, torrentId) => {
  const diag = torrentService.getDiagnostics(torrentId);
  if (diag) {
    diag.nat = nat.status();
    diag.policy = piecePolicy.status();
    diag.netPath = netPath.status();
    diag.portFallback = portFallback;
    diag.inboundPeak = diag.inboundPeak || 0;
  }
  return diag;
});

/**
 * Memory, per process, plus what the torrent engine is costing.
 *
 * Exists because the failure mode this app actually has is not a crash — it is
 * the main process growing until macOS compresses and swaps its pages, at which
 * point everything beachballs. `app.getAppMetrics()` is the only way to see the
 * renderer and GPU from in here, and its `memory.workingSetSize` is in KB.
 *
 * `scripts/mem-check.js` measures the same thing from outside with `top` and
 * `vmmap`; this is the version the Net panel can poll.
 */
ipcMain.handle('get-metrics', () => {
  const mem = process.memoryUsage();
  let processes = [];
  try {
    processes = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      // KB in Electron's API; bytes everywhere else in this payload.
      footprintBytes: (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) * 1024,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
    }));
  } catch (_) {
    /* metrics are best-effort; never let them break the panel */
  }
  return {
    main: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      // Buffers live here, not in the JS heap — which is where the piece caches
      // and every wire's read/write buffer actually show up.
      arrayBuffersBytes: mem.arrayBuffers,
      maxEventLoopLagMs: Math.max(0, Math.round(maxLagMs)),
    },
    torrents: torrentService.getMemoryCost(),
    // Next to liveTorrents, this is the pairing that answers the question the whole
    // overhaul is about: does cost track what is *active*, or how much music has
    // ever been added?
    library: library.stats(),
    artwork: artwork.stats(),
    // Open read streams, per kind. Worth reporting because the failure it detects
    // is invisible otherwise: a descriptor that is never released turns into a 503
    // several minutes into a track, which the media element reports as a bare
    // MediaError with no way to tell it from a bad file.
    fileServer: fileServer.stats(),
    processes: processes,
  };
});

ipcMain.handle('retry-port-mapping', async () => {
  const status = await nat.retry();
  send('nat-status', status);
  return status;
});

// -- network path ----------------------------------------------------------
//
// These are the only entry points that run probes or subprocesses. The 2s
// diagnostics poll reads netPath.status(), which is cached and synchronous.

ipcMain.handle('run-net-preflight', async () => {
  await netPath.refreshFingerprint();
  return netPath.preflight({ force: true });
});

ipcMain.handle('check-public-ip', () => netPath.publicIp());

ipcMain.handle('clear-public-ip', () => {
  netPath.clearPublicIp();
});

ipcMain.handle('remember-home-network', async () => {
  const fp = await netPath.fingerprint();
  if (!fp) {
    return { error: "Couldn't identify this network — no gateway hardware address in the ARP table." };
  }
  setPref('homeNetwork', fp);
  netPath.setHome(fp);
  await netPath.refreshFingerprint();
  return { home: fp };
});

ipcMain.handle('forget-home-network', () => {
  setPref('homeNetwork', null);
  netPath.setHome(null);
  return { home: null };
});

ipcMain.handle('open-torrent-folder', async (event, torrentId, fileIndex) => {
  // Select the track itself when the caller knows which one. `showItemInFolder`
  // opens the enclosing folder with the file highlighted, which for a 242-file
  // discography is the difference between an answer and a starting point — opening
  // the torrent root left the user looking at 20 album folders.
  if (fileIndex != null) {
    const record = library.get(torrentId);
    const track = record && record.tracks.find((t, i) => (t.i != null ? t.i : i) === fileIndex);
    if (record && record.root && track) {
      const full = path.join(record.root, track.path);
      try {
        await fsp.access(full);
        shell.showItemInFolder(full);
        return { success: true };
      } catch (_) {
        /* gone from disk — fall through to the album folder */
      }
    }
  }

  // Index fallback, for the same reason the file server has one: Reveal in Finder is
  // reachable from four places in the UI and would break for every archived album if
  // it could only ask a live torrent. The album folder is the first path segment of
  // any track, which is how webtorrent lays it out under the download root.
  let folderPath = torrentService.getTorrentPath(torrentId);
  if (!folderPath) {
    const record = library.get(torrentId);
    const first = record && record.tracks[0];
    if (record && record.root && first) {
      const segment = String(first.path).split('/')[0];
      folderPath = segment ? path.join(record.root, segment) : record.root;
    } else if (record && record.root) {
      folderPath = record.root;
    }
  }
  if (!folderPath) return { error: 'Album not found' };
  try {
    const err = await shell.openPath(folderPath);
    return err ? { error: err } : { success: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

/**
 * Re-fetch a track whose bytes are wrong, from the swarm.
 *
 * The index's `verified` flag only ever meant "a file of exactly the right length
 * exists at that path" — see the note in library-import.js, which is explicit that
 * size is not proof. It cannot be: the drive is exFAT over USB and this app has
 * been force-quit mid-write more than once, which leaves a full-length file holding
 * bytes that were never written. The symptom is a track that plays perfectly until
 * the damaged region and then dies, which is indistinguishable to the player from a
 * format it cannot handle.
 *
 * The only thing that can tell good bytes from bad is the torrent's piece hashes,
 * so repair means: stop serving the file locally, then put the torrent back up.
 * WebTorrent re-hashes what is on disk and re-downloads whatever fails — no
 * separate repair machinery, and no re-downloading the other 6 GB.
 *
 * A second request for the same track is refused, and that refusal is the useful
 * part. If the piece hashes accepted the file, every peer in the swarm holds these
 * exact bytes and the damage is in the release itself — which is what happened the
 * first time this ran. Offering the same button again would be an infinite loop
 * dressed up as a fix.
 */
ipcMain.handle('repair-track', async (event, albumId, fileIndex) => {
  const record = library.get(albumId);
  if (!record) return { error: 'That album is not in the library.' };
  const track = record.tracks.find((t, i) => (t.i != null ? t.i : i) === fileIndex);
  if (!track) return { error: 'That track is not in the index.' };

  // Never re-download over a file the user chose. That is the whole point of the
  // flag, and this handler is the most direct way to destroy it.
  if (track.substituted) {
    return {
      error:
        'You replaced this track by hand, so re-downloading it would overwrite your ' +
        'copy with the release’s damaged version. Delete the file first if that is ' +
        'what you want.',
      permanent: true,
    };
  }

  // A file that is simply absent is always worth fetching, even if a previous repair
  // concluded the release was damaged: there is nothing on disk to compare against,
  // and refusing would leave a hole the app could never fill.
  let onDisk = false;
  if (record.root) {
    try {
      await fsp.access(path.join(record.root, track.path));
      onDisk = true;
    } catch (_) {
      onDisk = false;
    }
  }

  if (track.repairedAt && onDisk) {
    return {
      error:
        'Already re-downloaded this track on ' + String(track.repairedAt).slice(0, 10) +
        ' and the bytes match the torrent, so every peer has the same damaged file. ' +
        'This one is broken in the release itself — a different copy is the only fix.',
      permanent: true,
    };
  }

  // Clearing `verified` is what stops the file server handing out a local URL for
  // known-bad bytes, and what makes set-playback-state wake the album on the next
  // attempt. `complete` goes with it: the album is no longer whole.
  const tracks = record.tracks.map((t, i) =>
    (t.i != null ? t.i : i) === fileIndex
      ? Object.assign({}, t, { verified: false, repairedAt: new Date().toISOString() })
      : t
  );
  await library.patch(albumId, {
    tracks: tracks,
    complete: false,
    presentBytes: Math.max(0, (record.presentBytes || 0) - (track.length || 0)),
    state: 'downloading',
  });

  // Load-bearing. The modtimes cache asserts "untouched since verified", which is
  // the one claim that must be withdrawn here: with it in place webtorrent skips
  // hashing entirely, reports the album complete and re-downloads nothing.
  torrentService.forgetCachedModtimes(albumId);
  if (record.realInfoHash) torrentService.forgetCachedModtimes(record.realInfoHash);

  // If it is already live it was added under the old modtimes, so it has to come
  // back down before it can be re-hashed.
  if (torrentService.has(albumId)) await torrentManager.archive(albumId, 'repair');
  const woke = await torrentManager.ensureLive(albumId, 'repairing a damaged track');
  send('torrent-ready', albumToTorrentShape(library.get(albumId)));
  console.log(
    '[repair]', track.name, '- marked unverified;', woke ? 'torrent is up' : 'could not bring the torrent up'
  );
  return woke
    ? { success: true, name: track.name }
    : { error: 'Marked for repair, but the torrent could not be started.' };
});

ipcMain.handle('open-download-folder', async () => {
  const folderPath = torrentService.getDownloadPath();
  try {
    const err = await shell.openPath(folderPath);
    return err ? { error: err } : { success: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});
