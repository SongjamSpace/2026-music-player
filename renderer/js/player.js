(function () {
  'use strict';

  var audio = null;
  var video = null;
  var stage = null;
  var active = null;

  var queue = [];      // file indices, in play order
  // One-shot queue handed to the next play() call — see playScoped().
  var pendingQueue = null;
  var queuePos = -1;
  var watchdog = null;
  var lastTimeAt = 0;
  var lastPositionSync = 0; // play head last reported to main, in seconds
  var corsRetried = {}; // src → already retried without CORS, so we don't loop

  var WATCHDOG_MS = 12000;
  var PREV_RESTART_THRESHOLD = 3; // seconds

  function pb() {
    return MP.store.state.playback;
  }

  function activeMedia() {
    return active;
  }

  // -- queue ---------------------------------------------------------------

  /**
   * Playable indices in track-list order.
   *
   * Delegates to MP.albums so the queue always matches what is on screen. On a
   * multi-album torrent the list is ordered by album, not by file index, and a
   * queue built from raw file order would advance to tracks the user cannot see.
   */
  function playableIndices(torrent) {
    return MP.albums.orderedIndices(torrent);
  }

  /**
   * Fisher-Yates over the playable indices, with the current track forced to
   * the front. Walking a fixed permutation (rather than picking at random each
   * time) makes Previous coherent and guarantees nothing repeats until the
   * cycle completes.
   */
  function shuffled(indices, firstIndex) {
    var a = indices.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    if (firstIndex != null) {
      var at = a.indexOf(firstIndex);
      if (at > 0) {
        a.splice(at, 1);
        a.unshift(firstIndex);
      }
    }
    return a;
  }

  function buildQueue(torrentId, startIndex) {
    var t = MP.store.getTorrent(torrentId);
    if (!t) return;
    var indices = playableIndices(t);
    queue = pb().shuffle ? shuffled(indices, startIndex) : indices;
    queuePos = startIndex != null ? queue.indexOf(startIndex) : -1;
  }

  function nextQueueIndex() {
    if (queuePos < 0) return null;
    if (queuePos + 1 < queue.length) return queue[queuePos + 1];
    return pb().repeat === 'all' && queue.length ? queue[0] : null;
  }

  /**
   * Tell the main process what is playing, which track is next, and where the
   * play head is. The old code hardcoded fileIndex + 1, which under shuffle
   * prefetches a file the user will never hear while the actual next track goes
   * unprioritised.
   *
   * The position matters as much as the indices: main sizes its readahead
   * window around it, so without it the window would sit at the start of the
   * file and a seek would land outside everything already requested.
   */
  function syncPriority() {
    var p = pb();
    if (p.torrentId == null || p.fileIndex == null) return;
    var next = nextQueueIndex();
    // Pin the cover: it's a few KB, and without this it competes with the audio
    // for the whole session and the artwork never arrives.
    var cover = MP.artwork.coverIndex(MP.store.getTorrent(p.torrentId));
    var duration = active && isFinite(active.duration) ? active.duration : p.duration || 0;
    window.playerAPI.setPlaybackState({
      torrentId: p.torrentId,
      fileIndex: p.fileIndex,
      nextFileIndex: next != null ? next : p.fileIndex,
      pinned: cover != null ? [cover] : [],
      currentTime: active ? active.currentTime : 0,
      duration: duration,
    });
  }

  // -- playback ------------------------------------------------------------

  function play(torrentId, fileIndex) {
    var t = MP.store.getTorrent(torrentId);
    if (!t || !t.files || !t.files[fileIndex]) return;
    var file = t.files[fileIndex];
    if (!file.streamURL) {
      MP.toast.error('This file has no stream URL yet — the torrent may still be starting up.');
      return;
    }

    var switchingTorrent = pb().torrentId !== torrentId;
    if (pendingQueue && pendingQueue.torrentId === torrentId) {
      queue = pb().shuffle ? shuffled(pendingQueue.indices, fileIndex) : pendingQueue.indices.slice();
      queuePos = queue.indexOf(fileIndex);
      pendingQueue = null;
    } else if (switchingTorrent || queue.indexOf(fileIndex) === -1) {
      buildQueue(torrentId, fileIndex);
    } else {
      queuePos = queue.indexOf(fileIndex);
    }

    var isVideo = MP.util.isVideoFile(file);
    var target = isVideo ? video : audio;

    if (active && active !== target) {
      active.pause();
      active.removeAttribute('src');
      active.load();
    }
    active = target;
    stage.classList.toggle('is-visible', isVideo);

    MP.store.setPlayback(
      {
        torrentId: torrentId,
        fileIndex: fileIndex,
        currentTime: 0,
        duration: MP.store.getDuration(torrentId, fileIndex) || 0,
        isBuffering: true,
        error: null,
      },
      'playback:track'
    );

    // Must be set BEFORE .src or it has no effect on the request. Web Audio
    // outputs silence for a CORS-tainted element, so the effects chain depends
    // on this — but it stays revocable at runtime (see the error handler).
    if (MP.dsp.wantCrossOrigin()) active.crossOrigin = 'anonymous';
    else active.removeAttribute('crossorigin');

    active.src = file.streamURL;
    // Always reached from a user gesture, which is the only place an
    // AudioContext can be created in a running state.
    MP.dsp.onPlay(file.streamURL);
    applyVolume();
    active.play().catch(function (err) {
      // Autoplay rejection is benign here (user-gesture initiated), but a
      // genuine load failure surfaces through the 'error' handler anyway.
      if (err && err.name !== 'AbortError') console.warn('[player] play() rejected:', err);
    });

    syncPriority();
    updateMediaSession(t, file);
    if (MP.store.state.selectedTorrentId !== torrentId) MP.store.select(torrentId);
  }

  function playAll(torrentId, shuffle) {
    var t = MP.store.getTorrent(torrentId);
    if (!t) return;
    var indices = playableIndices(t);
    if (!indices.length) return;
    if (shuffle !== pb().shuffle) setShuffle(!!shuffle, true);
    buildQueue(torrentId, null);
    play(torrentId, pb().shuffle ? queue[0] : indices[0]);
  }

  /**
   * Play a caller-defined subset — one album, from its section header.
   *
   * Handed over as a pending value rather than assigning `queue` directly,
   * because play() rebuilds the queue whenever the index it is given isn't
   * already in it, which is exactly the case when the album belongs to a
   * torrent we aren't playing yet.
   *
   * Self-healing by design: once this queue is live, double-clicking a track in
   * a different album fails the same `indexOf` test and falls back to the
   * whole-torrent queue with no extra code.
   */
  function playScoped(torrentId, indices, shuffle) {
    if (!indices || !indices.length) return;
    var playable = indices.filter(function (i) {
      var t = MP.store.getTorrent(torrentId);
      return t && t.files[i] && MP.util.isPlayable(t.files[i]);
    });
    if (!playable.length) return;
    if (shuffle != null && !!shuffle !== pb().shuffle) setShuffle(!!shuffle, true);
    pendingQueue = { torrentId: torrentId, indices: playable };
    play(torrentId, pb().shuffle ? playable[Math.floor(Math.random() * playable.length)] : playable[0]);
  }

  /** Insert a track directly after the current one without disturbing the rest. */
  function playNextUp(torrentId, fileIndex) {
    if (pb().torrentId !== torrentId || queuePos < 0) {
      play(torrentId, fileIndex);
      return;
    }
    var at = queue.indexOf(fileIndex);
    if (at !== -1) queue.splice(at, 1);
    queue.splice(queuePos + 1, 0, fileIndex);
    syncPriority();
    MP.toast.show('Playing next: ' + MP.store.getTorrent(torrentId).files[fileIndex].name);
  }

  function next(explicit) {
    var p = pb();
    if (p.repeat === 'one' && !explicit) {
      active.currentTime = 0;
      active.play().catch(function () {});
      return;
    }
    var idx = nextQueueIndex();
    if (idx == null) {
      // End of queue with repeat off: stop, but keep the track loaded so the
      // transport still shows what was playing.
      active.pause();
      active.currentTime = 0;
      return;
    }
    play(p.torrentId, idx);
  }

  function prev() {
    if (!active) return;
    if (active.currentTime > PREV_RESTART_THRESHOLD) {
      active.currentTime = 0;
      return;
    }
    if (queuePos > 0) {
      play(pb().torrentId, queue[queuePos - 1]);
    } else {
      active.currentTime = 0;
    }
  }

  function toggle() {
    if (!active || !active.src) {
      // Nothing loaded: start the selected torrent from the top.
      var id = MP.store.state.selectedTorrentId;
      if (id) playAll(id, pb().shuffle);
      return;
    }
    MP.dsp.onPlay(active.currentSrc);
    if (active.paused) active.play().catch(function () {});
    else active.pause();
  }

  function seekBy(seconds) {
    if (!active || !active.src || !isFinite(active.duration)) return;
    active.currentTime = MP.util.clamp(active.currentTime + seconds, 0, active.duration);
    syncPriority();
  }

  function seekTo(seconds) {
    if (!active || !active.src) return;
    active.currentTime = seconds;
    syncPriority();
  }

  // -- volume --------------------------------------------------------------

  function applyVolume() {
    if (!audio || !video) return;
    var p = pb();
    // Quadratic taper: a linear slider feels wrong across the bottom third.
    var gain = Math.pow(MP.util.clamp(p.volume, 0, 1), 2);

    if (MP.dsp.isAvailable()) {
      // Level lives in the graph's masterGain once the chain is live. This
      // avoids depending on whether Chromium applies element.volume before or
      // after the source node, and turns mute into a 20ms fade, not a hard cut.
      audio.volume = video.volume = 1;
      audio.muted = video.muted = false;
      MP.dspGraph.setOutputGain(p.muted ? 0 : gain);
    } else {
      audio.volume = gain;
      video.volume = gain;
      audio.muted = p.muted;
      video.muted = p.muted;
    }
  }

  var persistVolume = null;

  function setVolume(v, silent) {
    MP.store.setPlayback({ volume: MP.util.clamp(v, 0, 1), muted: false }, 'playback:volume');
    applyVolume();
    if (!silent && persistVolume) persistVolume();
  }

  function toggleMute() {
    MP.store.setPlayback({ muted: !pb().muted }, 'playback:volume');
    applyVolume();
    if (persistVolume) persistVolume();
  }

  function setShuffle(on, silent) {
    MP.store.setPlayback({ shuffle: on }, 'playback:mode');
    var p = pb();
    if (p.torrentId != null) {
      buildQueue(p.torrentId, p.fileIndex);
      syncPriority();
    }
    if (!silent) window.playerAPI.setPref('shuffle', on);
  }

  function cycleRepeat() {
    var order = ['off', 'all', 'one'];
    var nextMode = order[(order.indexOf(pb().repeat) + 1) % order.length];
    MP.store.setPlayback({ repeat: nextMode }, 'playback:mode');
    syncPriority();
    window.playerAPI.setPref('repeat', nextMode);
    return nextMode;
  }

  function toggleFullscreen() {
    if (!video || !stage.classList.contains('is-visible')) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else video.requestFullscreen().catch(function () {});
  }

  // -- media session -------------------------------------------------------

  function updateMediaSession(torrent, file) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: file.name.replace(/\.[^.]+$/, ''),
        artist: torrent.name || '',
        album: torrent.name || '',
      });
    } catch (_) {
      /* MediaMetadata unavailable — the action handlers below still work. */
    }
  }

  function installMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var actions = {
      play: function () { if (active) active.play().catch(function () {}); },
      pause: function () { if (active) active.pause(); },
      nexttrack: function () { next(true); },
      previoustrack: prev,
      seekto: function (details) { if (details.seekTime != null) seekTo(details.seekTime); },
    };
    Object.keys(actions).forEach(function (name) {
      try {
        navigator.mediaSession.setActionHandler(name, actions[name]);
      } catch (_) {
        /* unsupported action — ignore */
      }
    });
  }

  // -- media events --------------------------------------------------------

  function clearWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  /**
   * The WebTorrent server honours Range requests, but the bytes may simply not
   * exist yet — the request then hangs with no error. Clamping the scrubber to
   * the buffered edge would be wrong (pieces aren't guaranteed sequential), so
   * instead: show buffering immediately, and if nothing arrives, offer a way
   * back to a position that is downloaded.
   */
  function armWatchdog() {
    clearWatchdog();
    var at = active ? active.currentTime : 0;
    watchdog = setTimeout(function () {
      if (!active || !pb().isBuffering) return;
      var buffered = bufferedEnd();
      MP.toast.show('Still fetching that part of the track.', {
        duration: 9000,
        action:
          buffered > 0
            ? { label: 'Back to buffered', onClick: function () { seekTo(Math.max(0, buffered - 2)); } }
            : null,
      });
      lastTimeAt = at;
    }, WATCHDOG_MS);
  }

  function bufferedEnd() {
    if (!active || !active.buffered || !active.buffered.length) return 0;
    var t = active.currentTime;
    for (var i = 0; i < active.buffered.length; i++) {
      if (active.buffered.start(i) <= t && t <= active.buffered.end(i)) {
        return active.buffered.end(i);
      }
    }
    return active.buffered.end(active.buffered.length - 1);
  }

  var ERROR_MESSAGES = {
    1: 'Playback was aborted.',
    2: 'Network error — the torrent stream dropped.',
    3: 'Could not decode this file. The downloaded data may be incomplete or corrupt.',
    4: 'This format isn’t supported by the player.',
  };

  function attach(media) {
    media.addEventListener('loadstart', function () {
      if (media !== active) return;
      MP.store.setPlayback({ isBuffering: true, error: null }, 'playback:state');
    });

    var onMeta = function () {
      if (media !== active) return;
      var d = media.duration;
      MP.store.setPlayback({ duration: isFinite(d) ? d : 0 }, 'playback:state');
      // Real duration for free, from the track that's playing anyway. Cached and
      // persisted, so the Length column permanently fills in over time.
      var p = pb();
      if (isFinite(d) && d > 0 && p.torrentId != null) {
        MP.store.setDuration(p.torrentId, p.fileIndex, d);
      }
    };
    media.addEventListener('loadedmetadata', onMeta);
    // Streams routinely report Infinity first and correct themselves later.
    media.addEventListener('durationchange', onMeta);

    ['canplay', 'playing'].forEach(function (evt) {
      media.addEventListener(evt, function () {
        if (media !== active) return;
        clearWatchdog();
        MP.store.setPlayback({ isBuffering: false }, 'playback:state');
      });
    });

    ['waiting', 'stalled'].forEach(function (evt) {
      media.addEventListener(evt, function () {
        if (media !== active) return;
        MP.store.setPlayback({ isBuffering: true }, 'playback:state');
        armWatchdog();
      });
    });

    media.addEventListener('seeking', function () {
      if (media !== active) return;
      MP.store.setPlayback({ isBuffering: true }, 'playback:state');
      armWatchdog();
    });

    media.addEventListener('seeked', function () {
      if (media !== active) return;
      MP.store.setPlayback({ isBuffering: false }, 'playback:state');
    });

    media.addEventListener('timeupdate', function () {
      if (media !== active) return;
      // Time is passed as a payload, never written into state per frame.
      MP.store.state.playback.currentTime = media.currentTime;
      MP.store.emit('playback:time', {
        currentTime: media.currentTime,
        duration: isFinite(media.duration) ? media.duration : 0,
      });
      // timeupdate fires ~4x/sec; main only re-evaluates its readahead window
      // once a second, so anything faster is pure IPC churn.
      if (media.currentTime - lastPositionSync >= 1 || media.currentTime < lastPositionSync) {
        lastPositionSync = media.currentTime;
        syncPriority();
      }
    });

    media.addEventListener('progress', function () {
      if (media !== active) return;
      MP.store.emit('playback:buffered', {
        end: bufferedEnd(),
        duration: isFinite(media.duration) ? media.duration : 0,
      });
    });

    media.addEventListener('play', function () {
      if (media !== active) return;
      MP.store.setPlayback({ isPlaying: true }, 'playback:state');
    });

    media.addEventListener('pause', function () {
      if (media !== active) return;
      MP.store.setPlayback({ isPlaying: false }, 'playback:state');
    });

    media.addEventListener('ended', function () {
      if (media !== active) return;
      next(false);
    });

    media.addEventListener('error', function () {
      if (media !== active) return;
      clearWatchdog();
      var code = media.error ? media.error.code : 0;

      // Parachute: if the failure could be the CORS request we added for the
      // effects chain, drop it and retry once. Losing the equaliser is a far
      // better outcome than losing playback, and this is the only place we'd
      // find out that the ACAO header didn't land.
      if (media.crossOrigin && !corsRetried[media.currentSrc]) {
        corsRetried[media.currentSrc] = true;
        MP.dsp.disableCrossOrigin('media error code ' + code);
        var resumeAt = media.currentTime;
        media.removeAttribute('crossorigin');
        media.load();
        if (resumeAt > 0) media.currentTime = resumeAt;
        media.play().catch(function () {});
        return;
      }

      var message = ERROR_MESSAGES[code] || 'Playback failed.';
      MP.store.setPlayback({ isPlaying: false, isBuffering: false, error: message }, 'playback:state');
      var torrentId = pb().torrentId;
      MP.toast.error(message, {
        action: torrentId
          ? { label: 'Reveal in Finder', onClick: function () { MP.actions.openTorrentFolder(torrentId); } }
          : null,
      });
    });
  }

  function init(prefs) {
    audio = document.getElementById('audio-player');
    video = document.getElementById('video-player');
    stage = document.getElementById('video-stage');

    // Handlers attach to both elements once and are never removed — the same
    // defensive posture the preload constraint forces, and it avoids churn on
    // every track change.
    attach(audio);
    attach(video);
    installMediaSession();
    // The graph adopts these only after the CORS probe passes.
    MP.dsp.setElements(audio, video);

    persistVolume = MP.util.debounce(function () {
      window.playerAPI.setPref('volume', pb().volume);
      window.playerAPI.setPref('muted', pb().muted);
    }, 600);

    MP.store.setPlayback({
      volume: prefs.volume != null ? prefs.volume : 0.8,
      muted: !!prefs.muted,
      shuffle: !!prefs.shuffle,
      repeat: prefs.repeat || 'off',
    });
    applyVolume();

    document.addEventListener('fullscreenchange', function () {
      MP.store.emit('playback:state', pb());
    });
  }

  window.MP.player = {
    init: init,
    play: play,
    playAll: playAll,
    playNextUp: playNextUp,
    playScoped: playScoped,
    next: next,
    prev: prev,
    toggle: toggle,
    seekBy: seekBy,
    seekTo: seekTo,
    setVolume: setVolume,
    // Re-applies level after the DSP graph goes live, so control moves from the
    // element to masterGain without the user hearing a step.
    refreshVolume: applyVolume,
    toggleMute: toggleMute,
    setShuffle: setShuffle,
    cycleRepeat: cycleRepeat,
    toggleFullscreen: toggleFullscreen,
    syncPriority: syncPriority,
    activeMedia: activeMedia,
    bufferedEnd: bufferedEnd,
    isVideoActive: function () { return active === video; },
  };
})();
