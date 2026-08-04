(function () {
  'use strict';

  var root, artEl, titleEl, metaEl, meterFill, meterEl, playBtn, shuffleBtn, folderBtn, removeBtn;
  var currentId = null;
  var unsubProgress = null;

  function metaText(t) {
    var parts = [];
    var count = t.mediaCount != null ? t.mediaCount : t.files ? t.files.length : 0;
    if (count) parts.push(count === 1 ? '1 track' : count + ' tracks');
    if (t.length) parts.push(MP.util.formatBytes(t.length));
    if (t.done) {
      // Say when the album is not purely the release any more. Without it, "Complete"
      // hides the reason this album never seeds and never re-downloads.
      var swapped = (t.files || []).filter(function (f) { return f.substituted; }).length;
      parts.push(swapped ? 'Complete · ' + swapped + ' replaced by hand' : 'Complete');
    } else {
      parts.push(Math.round((t.progress || 0) * 100) + '%');
      // "no peers" is only true of a torrent that is actually looking for them.
      // Most of the library has no live torrent at any moment, and reporting that
      // as zero peers reads as a swarm problem rather than as "asleep".
      if (t.live === false) parts.push('queued');
      else parts.push(t.numPeers ? t.numPeers + (t.numPeers === 1 ? ' peer' : ' peers') : 'no peers');
      // formatSpeed renders 0 as an em dash, which reads as "stalled" — that's
      // the intent, since downloadSpeed is a trailing average and genuinely
      // sits at zero between bursts.
      if (t.downloadSpeed) parts.push(MP.util.formatSpeed(t.downloadSpeed));
      var eta = MP.util.formatETA(t.timeRemaining);
      if (eta && t.numPeers) parts.push(eta);
    }
    return parts.join(' · ');
  }

  function paint(t) {
    titleEl.textContent = t.name || t.id;
    metaEl.textContent = metaText(t);
    meterFill.style.setProperty('--fill', (t.progress || 0).toFixed(4));
    meterEl.hidden = !!t.done;
    // Idempotent — no-ops until the cover file finishes downloading.
    MP.artwork.apply(artEl, t);

    var playable = !!(t.files && t.files.length);
    playBtn.disabled = !playable;
    shuffleBtn.disabled = !playable;
  }

  function onSelection(id) {
    // Swap the per-torrent progress subscription rather than filtering a global
    // one — this is the case that justifies topic-scoped subscribe/unsubscribe.
    if (unsubProgress) {
      unsubProgress();
      unsubProgress = null;
    }
    currentId = id;

    if (!id) {
      root.hidden = true;
      return;
    }
    var t = MP.store.getTorrent(id);
    if (!t) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    paint(t);
    unsubProgress = MP.store.subscribe('torrent:progress:' + id, paint);
  }

  function init() {
    root = document.getElementById('torrent-header');
    artEl = root.querySelector('.artwork');
    titleEl = root.querySelector('.torrent-header__title');
    metaEl = root.querySelector('.torrent-header__meta');
    meterEl = root.querySelector('.torrent-header__meter');
    meterFill = meterEl.querySelector('.meter__fill');
    playBtn = document.getElementById('btn-play-all');
    shuffleBtn = document.getElementById('btn-shuffle-all');
    folderBtn = document.getElementById('btn-open-torrent-folder');
    removeBtn = document.getElementById('btn-remove-torrent');

    artEl.insertAdjacentHTML('afterbegin', MP.icons.svg('music', 40));

    playBtn.addEventListener('click', function () {
      if (currentId) MP.player.playAll(currentId, false);
    });
    shuffleBtn.addEventListener('click', function () {
      if (currentId) MP.player.playAll(currentId, true);
    });
    folderBtn.addEventListener('click', function () {
      if (currentId) MP.actions.openTorrentFolder(currentId);
    });
    removeBtn.addEventListener('click', function () {
      if (currentId) MP.actions.removeTorrent(currentId, false);
    });

    // Mounted here rather than in index.html so the panel owns its own markup
    // and can be lifted out without leaving an empty container behind.
    MP.netPanel.init(root.querySelector('.torrent-header__body'));

    MP.store.subscribe('selection', onSelection);
    MP.store.subscribe('torrents:list', function () {
      if (currentId && MP.store.getTorrent(currentId)) paint(MP.store.getTorrent(currentId));
      else onSelection(MP.store.state.selectedTorrentId);
    });

    onSelection(MP.store.state.selectedTorrentId);
  }

  window.MP.torrentHeader = { init: init };
})();
