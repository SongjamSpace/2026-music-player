(function () {
  'use strict';

  /**
   * Topic-scoped state store.
   *
   * A single global "something changed" notification would just relocate the
   * old full-rebuild problem one layer up, so subscribers name the exact topic
   * they care about. The 500ms progress tick emits only
   * `torrent:progress:<id>`; structural topics fire only on real structural
   * change.
   */

  var state = {
    torrents: new Map(),
    torrentOrder: [],
    selectedTorrentId: null,
    playback: {
      torrentId: null,
      fileIndex: null,
      isPlaying: false,
      isBuffering: false,
      isScrubbing: false,
      currentTime: 0,
      duration: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: 'off',
      queue: [],
      queuePos: -1,
      error: null,
    },
    settings: {
      downloadPath: '',
      defaultDownloadPath: '',
      prefetch: true,
      readDurations: false,
      uploadLimit: 1500000,
      pieceStrategy: 'auto',
      expectedPath: 'auto',
      homeNetwork: null,
      peerEncryption: true,
      torrentPort: null,
      version: '',
    },
    durations: new Map(),
    ui: { filter: '' },
  };

  var topics = new Map();

  function subscribe(topic, fn) {
    if (!topics.has(topic)) topics.set(topic, new Set());
    topics.get(topic).add(fn);
    return function unsubscribe() {
      var set = topics.get(topic);
      if (set) set.delete(fn);
    };
  }

  function emit(topic, payload) {
    var set = topics.get(topic);
    if (!set || set.size === 0) return;
    set.forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[store] subscriber for "' + topic + '" threw:', err);
      }
    });
  }

  // -- progress coalescing -------------------------------------------------
  // Redundant at 2 Hz with one torrent, cheap insurance at twenty. The hidden
  // gate means a minimised window costs nothing.

  var pendingProgress = new Map();
  var rafHandle = null;
  var dirtyWhileHidden = false;

  function flushProgress() {
    rafHandle = null;
    if (document.hidden) {
      dirtyWhileHidden = true;
      pendingProgress.clear();
      return;
    }
    pendingProgress.forEach(function (torrent, id) {
      emit('torrent:progress:' + id, torrent);
    });
    pendingProgress.clear();
  }

  function queueProgress(torrent) {
    pendingProgress.set(torrent.id, torrent);
    if (rafHandle == null) rafHandle = requestAnimationFrame(flushProgress);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && dirtyWhileHidden) {
      dirtyWhileHidden = false;
      state.torrents.forEach(function (t) {
        emit('torrent:progress:' + t.id, t);
      });
      emit('torrents:list', state.torrentOrder);
    }
  });

  // -- torrents ------------------------------------------------------------

  /**
   * Merge one IPC payload into the store and emit only the topics that actually
   * changed. The 500ms tick omits `files`, `name`, `magnetURI` and `done`, so
   * those must be carried forward from the existing entry.
   */
  function upsertTorrent(data) {
    if (!data || !data.id) return;
    var id = data.id;
    var existing = state.torrents.get(id);
    var isNew = !existing;

    var pick = function (key) {
      return data[key] != null ? data[key] : existing ? existing[key] : undefined;
    };

    var files = data.files != null ? data.files : existing ? existing.files : [];

    // Counted once when the file list arrives rather than on every 500ms tick:
    // "tracks" must mean playable media, not cue sheets and rip logs.
    var mediaCount;
    if (existing && existing.files === files && existing.mediaCount != null) {
      mediaCount = existing.mediaCount;
    } else {
      mediaCount = (files || []).filter(window.MP.util.isMediaFile).length;
    }
    var progress = data.progress != null ? data.progress : existing ? existing.progress || 0 : 0;

    // `done: true` is emitted exactly once and then the interval is cleared, so
    // a torrent that completes while the window reloads would otherwise never
    // read as finished.
    var done = data.done != null ? data.done : existing && existing.done ? true : progress >= 0.999;

    var next = {
      id: id,
      name: pick('name') || (existing && existing.name) || id,
      magnetURI: pick('magnetURI'),
      files: files || [],
      mediaCount: mediaCount,
      fileProgress: data.fileProgress != null ? data.fileProgress : existing && existing.fileProgress,
      progress: progress,
      numPeers: data.numPeers != null ? data.numPeers : (existing && existing.numPeers) || 0,
      downloadSpeed: data.downloadSpeed != null ? data.downloadSpeed : (existing && existing.downloadSpeed) || 0,
      timeRemaining: pick('timeRemaining'),
      downloaded: pick('downloaded'),
      length: pick('length'),
      done: done,
      pending: data.pending === true ? true : files && files.length > 0 ? false : existing ? existing.pending : false,
      lastUpdate: performance.now(),
    };

    state.torrents.set(id, next);
    if (isNew) state.torrentOrder.push(id);

    var filesChanged = !existing || existing.files !== next.files;
    var structural =
      isNew ||
      existing.name !== next.name ||
      existing.done !== next.done ||
      existing.pending !== next.pending ||
      (existing.files ? existing.files.length : 0) !== (next.files ? next.files.length : 0);

    if (structural) emit('torrents:list', state.torrentOrder);
    if (filesChanged) emit('torrent:files:' + id, next);
    queueProgress(next);

    // First torrent auto-selects, so the content pane is never pointlessly empty.
    if (state.selectedTorrentId == null) select(id);

    return next;
  }

  /** Insert a placeholder row keyed on the infohash, before metadata arrives. */
  function addPending(id, label) {
    if (!id || state.torrents.has(id)) return;
    state.torrents.set(id, {
      id: id,
      name: label || 'Fetching metadata…',
      files: [],
      fileProgress: null,
      progress: 0,
      numPeers: 0,
      downloadSpeed: 0,
      done: false,
      pending: true,
      lastUpdate: performance.now(),
    });
    state.torrentOrder.push(id);
    emit('torrents:list', state.torrentOrder);
    if (state.selectedTorrentId == null) select(id);
  }

  function removeTorrent(id) {
    if (!state.torrents.has(id)) return;
    state.torrents.delete(id);
    state.torrentOrder = state.torrentOrder.filter(function (x) { return x !== id; });
    if (state.selectedTorrentId === id) {
      select(state.torrentOrder.length ? state.torrentOrder[0] : null);
    }
    emit('torrents:list', state.torrentOrder);
  }

  function getTorrent(id) {
    return state.torrents.get(id) || null;
  }

  function select(id) {
    if (state.selectedTorrentId === id) return;
    state.selectedTorrentId = id;
    // Per-file progress is expensive to compute in main — it walks every piece
    // of every file — so it only does it for the torrent actually on screen.
    if (window.playerAPI && window.playerAPI.setActiveTorrent) window.playerAPI.setActiveTorrent(id);
    emit('selection', id);
  }

  /**
   * `fileProgress` from the periodic tick is authoritative; `files[i].progress`
   * is captured once when the torrent becomes ready and goes stale immediately.
   */
  function fileProgress(torrentId, fileIndex) {
    var t = state.torrents.get(torrentId);
    if (!t) return 0;
    var arr = t.fileProgress;
    if (arr && arr[fileIndex] && arr[fileIndex].progress != null) {
      return Math.min(1, arr[fileIndex].progress);
    }
    if (t.files && t.files[fileIndex] && t.files[fileIndex].progress != null) {
      return Math.min(1, t.files[fileIndex].progress);
    }
    return 0;
  }

  // -- playback ------------------------------------------------------------

  function setPlayback(patch, topic) {
    Object.assign(state.playback, patch);
    if (topic) emit(topic, state.playback);
  }

  // -- durations -----------------------------------------------------------

  function durationKey(torrentId, fileIndex) {
    return torrentId + ':' + fileIndex;
  }

  function getDuration(torrentId, fileIndex) {
    var v = state.durations.get(durationKey(torrentId, fileIndex));
    return v != null && isFinite(v) ? v : null;
  }

  function setDuration(torrentId, fileIndex, seconds) {
    if (!isFinite(seconds) || seconds <= 0) return;
    var key = durationKey(torrentId, fileIndex);
    if (state.durations.get(key) === seconds) return;
    state.durations.set(key, seconds);
    emit('durations', key);
    if (persistDurations) {
      var plain = {};
      state.durations.forEach(function (v, k) { plain[k] = v; });
      persistDurations(plain);
    }
  }

  // Assigned by _initDurationPersistence() at boot, once MP.util exists.
  var persistDurations = null;

  function setFilter(value) {
    if (state.ui.filter === value) return;
    state.ui.filter = value;
    emit('filter', value);
  }

  window.MP.store = {
    state: state,
    subscribe: subscribe,
    emit: emit,
    upsertTorrent: upsertTorrent,
    addPending: addPending,
    removeTorrent: removeTorrent,
    getTorrent: getTorrent,
    select: select,
    fileProgress: fileProgress,
    setPlayback: setPlayback,
    getDuration: getDuration,
    setDuration: setDuration,
    setFilter: setFilter,
    _initDurationPersistence: function () {
      persistDurations = window.MP.util.debounce(function (plain) {
        window.playerAPI.setPref('durations', plain);
      }, 2000);
    },
  };
})();
