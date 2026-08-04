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
  // Guards the CORS parachute below against retrying the same failure forever.
  // Reset once a track actually plays, because a media error is no longer a
  // once-per-install event: a stale streamURL from an archived torrent, an
  // unplugged drive or a 503 from the file server all land here, and none of
  // them should burn the one retry for the rest of the session.
  var corsRetried = false;
  // One source swap per track — see recoverSource(). Reset in play(), not on
  // 'canplay': the swap itself produces a canplay, and resetting there would let
  // two sources ping-pong on a file that is broken both ways.
  var sourceRecovered = false;
  // Optional main-process tools, asked once at init. ffmpeg is not bundled, so a
  // Repair action that shells out to it must not be offered when it is absent.
  var capabilities = { repairAudio: false, verifyAudio: false };

  var WATCHDOG_MS = 12000;
  var PREV_RESTART_THRESHOLD = 3; // seconds

  function pb() {
    return MP.store.state.playback;
  }

  /**
   * Decide, after the fact, whether a media error was really a CORS rejection.
   *
   * `MediaError` is uselessly coarse here: a cross-origin refusal, a 404 for a
   * track whose torrent has been archived, a 503 from the file server and an
   * unplugged drive all arrive as the same code. Acting on the code alone meant
   * one unrelated load failure persisted `corsOk: false` and killed the effects
   * chain for every future launch, with no way back.
   *
   * A cross-origin `fetch` of the same URL answers the question directly: if it
   * completes, the ACAO header landed and CORS was never the problem. A non-2xx
   * status means the resource is gone, which is a different bug.
   *
   * A rejected fetch is still ambiguous — an unreachable server and a refused
   * cross-origin read both throw `TypeError` — so it is followed by a `no-cors`
   * request, which is exempt from the ACAO check. That one succeeding (opaque)
   * where the CORS one failed is the only evidence that actually implicates CORS.
   */
  function confirmCorsFailure(src, code) {
    if (!src) return;
    var opts = { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store' };
    fetch(src, Object.assign({ mode: 'cors' }, opts))
      .then(function (res) {
        if (res.ok || res.status === 206 || res.status === 416) {
          console.warn(
            '[player] media error code ' + code + ' but the URL is CORS-readable — ' +
              'not a CORS problem, leaving audio effects enabled'
          );
          return;
        }
        console.warn('[player] media error code ' + code + ' — server said ' + res.status);
      })
      .catch(function (corsErr) {
        return fetch(src, Object.assign({ mode: 'no-cors' }, opts)).then(
          function () {
            // Reachable without the CORS check, refused with it.
            MP.dsp.disableCrossOrigin(
              'cross-origin read refused (' + ((corsErr && corsErr.message) || 'fetch failed') + ')'
            );
          },
          function () {
            console.warn(
              '[player] media error code ' + code + ' and the URL is unreachable — ' +
                'not a CORS problem, leaving audio effects enabled'
            );
          }
        );
      });
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
    // `localURL` reads the finished file straight off disk; `streamURL` goes
    // through webtorrent's piece store and needs the torrent live. Preferring the
    // local one is what makes a downloaded album playable without the torrent
    // engine being involved at all.
    var src = file.localURL || file.streamURL;
    if (!src) {
      MP.toast.error('This file has no stream URL yet — the torrent may still be starting up.');
      return;
    }

    sourceRecovered = false;
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

    active.src = src;
    // Always reached from a user gesture, which is the only place an
    // AudioContext can be created in a running state.
    MP.dsp.onPlay(src);
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

  /**
   * Reload the current track from the current position.
   *
   * Only used by the "try again" action on the effects banner. The element's
   * `crossorigin` attribute can only be changed before `.src` is assigned, so
   * re-enabling effects after they were switched off means starting the load
   * over — there is no way to adopt an element that was already loaded without
   * it. Returns false if there is nothing playing to reload.
   */
  function reloadCurrent() {
    var p = pb();
    if (p.torrentId == null || p.fileIndex == null) return false;
    var at = active ? active.currentTime : 0;
    play(p.torrentId, p.fileIndex);
    if (at > 0 && active) {
      var el = active;
      var restore = function () {
        el.removeEventListener('loadedmetadata', restore);
        try { el.currentTime = at; } catch (_) {}
      };
      el.addEventListener('loadedmetadata', restore);
    }
    return true;
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
    // Chromium reports code 4 for a source it could not load at all — a closed
    // server, a 404, a refused range — as well as for one it cannot decode, and
    // the first is far more common here. Claiming the format is unsupported sent
    // one bug report chasing a FLAC that turned out to play perfectly.
    4: 'Could not load this track — the source may be unavailable.',
  };

  /**
   * Swap to the album's other source after a load failure, once per track.
   *
   * A track can be reachable two ways: `localURL`, read straight off disk, and
   * `streamURL`, served by that torrent's own HTTP server. The second one dies the
   * moment the torrent is archived — which happens on a timer — so a track that
   * started from the swarm can lose its source mid-play while the finished file is
   * sitting on disk. Refreshing the album from main is what makes the URLs current;
   * the store replaces the file list wholesale.
   */
  function recoverSource(media) {
    var p = pb();
    if (p.torrentId == null || p.fileIndex == null) return false;
    if (sourceRecovered) return false;
    sourceRecovered = true;

    var failed = media.currentSrc || media.src;
    var at = media.currentTime;

    window.playerAPI
      .getTorrents()
      .then(function (list) {
        (list || []).forEach(MP.store.upsertTorrent);
        var t = MP.store.getTorrent(p.torrentId);
        var file = t && t.files && t.files[p.fileIndex];
        var next = file && (file.localURL || file.streamURL);
        if (!next || next === failed) {
          reportPlaybackError(media.error ? media.error.code : 0, media);
          return;
        }
        console.warn('[player] source failed, retrying from', next === file.localURL ? 'disk' : 'the swarm');
        media.src = next;
        media.load();
        if (at > 0) {
          var restore = function () {
            media.removeEventListener('loadedmetadata', restore);
            try { media.currentTime = at; } catch (_) {}
          };
          media.addEventListener('loadedmetadata', restore);
        }
        media.play().catch(function () {});
      })
      .catch(function () {
        reportPlaybackError(media.error ? media.error.code : 0, media);
      });

    return true;
  }

  /**
   * A track we thought was on disk isn't, and main has started fetching it.
   *
   * Nothing to do but say so and wait: the album is live now, so the file gains a
   * `streamURL` as soon as the torrent has metadata, and the first bytes are
   * prioritised because this is the track someone just asked for. One retry, on a
   * store update rather than a timer, so it starts as soon as it can rather than
   * after a guessed delay.
   */
  function onTrackMissing(info) {
    if (!info) return;
    var p = pb();
    var forThisTrack = p.torrentId === info.albumId && p.fileIndex === info.fileIndex;

    MP.toast.show(
      '“' + info.name + '” is no longer on the drive' +
        (info.live ? ' — downloading it again.' : ', and the torrent could not be started.')
    );
    if (!forThisTrack || !info.live) return;

    MP.store.setPlayback({ error: 'Missing from the drive — downloading it again.' }, 'playback:state');

    // Two triggers, because either can be the one that makes the track playable.
    // `torrent:files:` fires when main re-sends the album and the URLs change, which
    // is what happens the moment the torrent goes live. `torrent:progress:` covers
    // an album that was already live. Subscribing only to progress was wrong: the
    // ticker runs for live torrents only, so an album that failed to wake would
    // never fire it and the retry would wait forever.
    var stops = [];
    var stop = function () {
      stops.forEach(function (fn) { fn(); });
      stops = [];
    };
    var attempt = function () {
      var t = MP.store.getTorrent(info.albumId);
      var file = t && t.files && t.files[info.fileIndex];
      if (!file || !(file.localURL || file.streamURL)) return;
      stop();
      // Only if the user is still waiting on this track — they may have moved on.
      var now = pb();
      if (now.torrentId !== info.albumId || now.fileIndex !== info.fileIndex) return;
      play(info.albumId, info.fileIndex);
    };
    stops.push(MP.store.subscribe('torrent:files:' + info.albumId, attempt));
    stops.push(MP.store.subscribe('torrent:progress:' + info.albumId, attempt));
    attempt();
  }

  function reportPlaybackError(code, media) {
    var p = pb();
    var t = p.torrentId != null ? MP.store.getTorrent(p.torrentId) : null;
    var file = t && t.files && t.files[p.fileIndex];
    // A track that was playing and then failed partway through is a damaged file,
    // not an unplayable format or a source that went away. The distinction matters
    // because only one of the three has a fix, and it is one we can actually apply:
    // the torrent's piece hashes know which bytes are wrong.
    var wasPlaying = media && media.currentTime > 1;
    var repairable = !!(file && file.localURL && wasPlaying);

    var message = repairable
      ? 'This track is damaged from about ' + MP.util.formatDuration(media.currentTime) + '.'
      : ERROR_MESSAGES[code] || 'Playback failed.';

    MP.store.setPlayback({ isPlaying: false, isBuffering: false, error: message }, 'playback:state');

    var action = null;
    // Patching beats re-downloading when it is available, and by a wide margin: the
    // damage is as likely to be in the release as on disk, and re-downloading cannot
    // fix the release. It also costs one file rather than re-hashing the album, and
    // leaves the torrent's own copy intact so the album keeps seeding.
    var canPatch = capabilities.repairAudio && repairable && !file.repaired &&
      MP.util.isLossless(file);

    if (canPatch) {
      action = {
        label: 'Repair',
        onClick: function () {
          MP.actions.repairAudio(p.torrentId, p.fileIndex).then(function (ok) {
            if (ok) play(p.torrentId, p.fileIndex);
          });
        },
      };
    } else if (repairable) {
      action = {
        label: 'Re-download',
        onClick: function () { MP.actions.repairTrack(p.torrentId, p.fileIndex); },
      };
    } else if (p.torrentId != null) {
      action = {
        label: 'Reveal in Finder',
        onClick: function () { MP.actions.openTorrentFolder(p.torrentId, p.fileIndex); },
      };
    }
    MP.toast.error(message, { action: action });
  }

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
        // Something loaded, so whatever the last error was, it wasn't terminal.
        corsRetried = false;
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
      if (media.crossOrigin && !corsRetried) {
        corsRetried = true;
        var failedSrc = media.currentSrc || media.src;
        var resumeAt = media.currentTime;
        media.removeAttribute('crossorigin');
        media.load();
        if (resumeAt > 0) media.currentTime = resumeAt;
        media.play().catch(function () {});
        // Retry first, conclude second. The element reports the same error code
        // for a CORS rejection, a 404 and a dead server, so blaming CORS on the
        // code alone permanently disabled the effects chain whenever a stale
        // streamURL failed to load. Ask the network directly instead.
        confirmCorsFailure(failedSrc, code);
        return;
      }

      // A source that vanished mid-track is the common cause of code 4, not a
      // codec the player can't handle. Try the album's other source before
      // reporting anything: a track streaming from a torrent that has since been
      // archived usually has a perfectly good file on disk to fall back to.
      if (recoverSource(media)) return;

      reportPlaybackError(code, media);
    });
  }

  function init(prefs) {
    window.playerAPI.getCapabilities().then(function (c) {
      if (c) capabilities = c;
    }).catch(function () { /* absent tools are the default */ });

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
    reloadCurrent: reloadCurrent,
    onTrackMissing: onTrackMissing,
    bufferedEnd: bufferedEnd,
    isVideoActive: function () { return active === video; },
  };
})();
