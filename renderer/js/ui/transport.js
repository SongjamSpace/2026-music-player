(function () {
  'use strict';

  var root, artEl, titleEl, subEl, posEl;
  var btnPlay, btnPrev, btnNext, btnShuffle, btnRepeat, btnMute, btnFullscreen;
  var scrubberWrap, scrubber, timeStart, timeEnd;
  var volumeInput, statusChip;

  var isScrubbing = false;
  var lastElapsed = '';
  var unsubArtwork = null;

  function pb() {
    return MP.store.state.playback;
  }

  // -- painting ------------------------------------------------------------

  function paintTrack() {
    var p = pb();
    var t = p.torrentId ? MP.store.getTorrent(p.torrentId) : null;
    var file = t && t.files ? t.files[p.fileIndex] : null;

    if (!file) {
      root.classList.add('is-idle');
      titleEl.textContent = 'Nothing playing';
      subEl.textContent = '';
      posEl.textContent = '';
      scrubber.disabled = true;
      btnPlay.disabled = false;
      return;
    }

    root.classList.remove('is-idle');
    titleEl.textContent = file.name;
    titleEl.title = file.name;
    subEl.textContent = t.name || '';
    subEl.title = t.name || '';

    var playable = t.files.filter(MP.util.isPlayable).length;
    var ordinal = t.files.slice(0, p.fileIndex + 1).filter(MP.util.isPlayable).length;
    posEl.textContent = playable ? 'Track ' + ordinal + ' of ' + playable : '';

    // The transport's art is a small tile, so take the 96px variant rather than
    // paying for a 512px decode it cannot show.
    MP.artwork.apply(artEl, t, null, { thumb: true });
    scrubber.disabled = false;
    btnFullscreen.hidden = !MP.util.isVideoFile(file);

    // The cover often lands after playback has already started, so watch this
    // torrent's progress until it does. Swapped on every track change.
    if (unsubArtwork) unsubArtwork();
    unsubArtwork = MP.store.subscribe('torrent:progress:' + t.id, function (live) {
      MP.artwork.apply(artEl, live, null, { thumb: true });
    });
  }

  function paintState() {
    var p = pb();
    MP.icons.set(btnPlay, p.isPlaying ? 'pause' : 'play', 17);
    btnPlay.setAttribute('aria-label', p.isPlaying ? 'Pause' : 'Play');

    btnShuffle.setAttribute('aria-pressed', p.shuffle ? 'true' : 'false');
    MP.icons.set(btnRepeat, p.repeat === 'one' ? 'repeatOne' : 'repeat');
    btnRepeat.setAttribute('aria-pressed', p.repeat === 'off' ? 'false' : 'true');
    btnRepeat.setAttribute(
      'aria-label',
      'Repeat: ' + (p.repeat === 'off' ? 'off' : p.repeat === 'all' ? 'all tracks' : 'this track')
    );

    MP.icons.set(btnMute, p.muted || p.volume === 0 ? 'mute' : 'volume');
    btnMute.setAttribute('aria-pressed', p.muted ? 'true' : 'false');
    volumeInput.value = String(Math.round(p.volume * 100));
    volumeInput.parentElement.style.setProperty('--vol', p.muted ? 0 : p.volume);

    paintStatus();
  }

  /**
   * The honest reason for a stall, read straight from the 500ms torrent payload
   * we already have. Turns an opaque buffering spinner into a diagnosis.
   */
  function paintStatus() {
    var p = pb();
    statusChip.classList.remove('is-error', 'is-buffering');

    if (p.error) {
      statusChip.textContent = p.error;
      statusChip.classList.add('is-error');
      return;
    }
    if (!p.isBuffering) {
      statusChip.textContent = '';
      return;
    }

    statusChip.classList.add('is-buffering');
    var t = p.torrentId ? MP.store.getTorrent(p.torrentId) : null;
    if (!t) {
      statusChip.textContent = 'Buffering…';
      return;
    }
    if (!t.numPeers) {
      statusChip.textContent = 'No peers — waiting for seeders';
      return;
    }
    var pct = Math.round(MP.store.fileProgress(t.id, p.fileIndex) * 100);
    statusChip.textContent = 'Buffering… ' + pct + '% · ' + MP.util.formatSpeed(t.downloadSpeed);
  }

  function paintTime(payload) {
    if (isScrubbing) return;
    var duration = payload.duration || pb().duration || 0;
    var elapsed = MP.util.formatDuration(payload.currentTime);
    if (elapsed !== lastElapsed) {
      lastElapsed = elapsed;
      timeStart.textContent = elapsed;
    }
    timeEnd.textContent = duration ? MP.util.formatDuration(duration) : '—:—';
    var ratio = duration ? payload.currentTime / duration : 0;
    scrubberWrap.style.setProperty('--played', ratio.toFixed(5));
    scrubber.value = String(Math.round(ratio * 1000));
  }

  function paintBuffered(payload) {
    var ratio = payload.duration ? payload.end / payload.duration : 0;
    scrubberWrap.style.setProperty('--buffered', MP.util.clamp(ratio, 0, 1).toFixed(4));
  }

  // -- scrubbing -----------------------------------------------------------
  //
  // Seeking on every `input` event would hammer the Range server and stutter,
  // and letting `timeupdate` keep driving the UI mid-drag makes the thumb fight
  // the user. So: preview on input, commit on change.

  function beginScrub() {
    isScrubbing = true;
    scrubberWrap.classList.add('is-scrubbing');
    MP.store.state.playback.isScrubbing = true;
  }

  function previewScrub() {
    var duration = pb().duration || 0;
    if (!duration) return;
    var seconds = (Number(scrubber.value) / 1000) * duration;
    timeStart.textContent = MP.util.formatDuration(seconds);
    scrubberWrap.style.setProperty('--played', (Number(scrubber.value) / 1000).toFixed(5));
  }

  function commitScrub() {
    var duration = pb().duration || 0;
    isScrubbing = false;
    MP.store.state.playback.isScrubbing = false;
    scrubberWrap.classList.remove('is-scrubbing');
    if (!duration) return;
    var seconds = (Number(scrubber.value) / 1000) * duration;
    scrubber.setAttribute('aria-valuetext', MP.util.formatDuration(seconds) + ' of ' + MP.util.formatDuration(duration));
    MP.player.seekTo(seconds);
  }

  function init() {
    root = document.getElementById('transport');
    artEl = root.querySelector('.artwork');
    titleEl = document.getElementById('np-title');
    subEl = document.getElementById('np-sub');
    posEl = document.getElementById('np-pos');

    btnPlay = document.getElementById('btn-play');
    btnPrev = document.getElementById('btn-prev');
    btnNext = document.getElementById('btn-next');
    btnShuffle = document.getElementById('btn-shuffle');
    btnRepeat = document.getElementById('btn-repeat');
    btnMute = document.getElementById('btn-mute');
    btnFullscreen = document.getElementById('btn-fullscreen');

    scrubberWrap = document.getElementById('scrubber');
    scrubber = scrubberWrap.querySelector('input');
    timeStart = document.getElementById('time-start');
    timeEnd = document.getElementById('time-end');
    volumeInput = document.getElementById('volume');
    statusChip = document.getElementById('status-chip');

    artEl.insertAdjacentHTML('afterbegin', MP.icons.svg('music', 24));
    MP.icons.set(btnPrev, 'prev');
    MP.icons.set(btnNext, 'next');
    MP.icons.set(btnShuffle, 'shuffle');
    MP.icons.set(btnFullscreen, 'expand');

    btnPlay.addEventListener('click', function () { MP.player.toggle(); });
    btnPrev.addEventListener('click', function () { MP.player.prev(); });
    btnNext.addEventListener('click', function () { MP.player.next(true); });
    btnShuffle.addEventListener('click', function () { MP.player.setShuffle(!pb().shuffle); });
    btnRepeat.addEventListener('click', function () { MP.player.cycleRepeat(); });
    btnMute.addEventListener('click', function () { MP.player.toggleMute(); });
    btnFullscreen.addEventListener('click', function () { MP.player.toggleFullscreen(); });

    scrubber.addEventListener('pointerdown', beginScrub);
    scrubber.addEventListener('keydown', beginScrub);
    scrubber.addEventListener('input', previewScrub);
    scrubber.addEventListener('change', commitScrub);
    scrubber.addEventListener('pointerup', commitScrub);
    scrubber.addEventListener('blur', function () {
      if (isScrubbing) commitScrub();
    });

    volumeInput.addEventListener('input', function () {
      MP.player.setVolume(Number(volumeInput.value) / 100);
    });

    MP.store.subscribe('playback:track', function () { paintTrack(); paintState(); });
    MP.store.subscribe('playback:state', paintState);
    MP.store.subscribe('playback:mode', paintState);
    MP.store.subscribe('playback:volume', paintState);
    MP.store.subscribe('playback:time', paintTime);
    MP.store.subscribe('playback:buffered', paintBuffered);

    // Buffering copy depends on live peer/speed numbers.
    MP.store.subscribe('torrents:list', function () {
      if (pb().isBuffering) paintStatus();
    });

    paintTrack();
    paintState();
    paintTime({ currentTime: 0, duration: 0 });
  }

  window.MP.transport = { init: init, refreshStatus: paintStatus };
})();
