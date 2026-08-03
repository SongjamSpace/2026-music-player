(function () {
  'use strict';

  var listEl, headEl, bannerEl, bannerText;
  var rows = new Map(); // fileIndex -> row component
  var currentId = null;
  var unsubProgress = null;
  var focusedIndex = 0;
  var skeletonCaption = null;
  var skeletonStartedAt = 0;
  var renderedCount = -1; // file count the current DOM reflects
  var typeahead = { buffer: '', timer: null };

  function createRow(torrent, file, index, ordinal) {
    var el = MP.util.tpl('#tpl-track-row');
    el.dataset.index = String(index);

    var indexEl = el.querySelector('.track-row__index');
    var playEl = el.querySelector('.track-row__play');
    var titleEl = el.querySelector('.track-row__label');
    var chipSlot = el.querySelector('.track-row__chips');
    var lenEl = el.querySelector('.track-row__len');
    var dlEl = el.querySelector('.track-row__pct');
    var fillEl = el.querySelector('.track-row__dl .meter__fill');
    var stateEl = el.querySelector('.track-row__state');

    indexEl.textContent = String(ordinal);
    MP.icons.set(playEl, 'play', 14);
    titleEl.textContent = file.name;
    titleEl.title = file.name;

    var playable = MP.util.isPlayable(file);

    if (!playable) {
      el.classList.add('is-unplayable');
      chipSlot.appendChild(MP.util.el('span', 'chip', 'Unsupported'));
    } else if (MP.util.isVideoFile(file)) {
      chipSlot.appendChild(MP.util.el('span', 'chip', 'Video'));
    }

    el.setAttribute('aria-label', file.name);
    el.setAttribute(
      'aria-disabled',
      playable ? 'false' : 'true'
    );

    var lastPct = -1;
    var lastLen = '';

    var api = {
      el: el,
      index: index,
      name: file.name,
      playable: playable,
      updateLength: function () {
        var d = MP.store.getDuration(torrent.id, index);
        var text = d ? MP.util.formatDuration(d) : MP.util.formatBytes(file.length);
        if (text === lastLen) return;
        lastLen = text;
        lenEl.textContent = text;
      },
      updateProgress: function () {
        var p = MP.store.fileProgress(torrent.id, index);
        var pct = Math.round(p * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        fillEl.style.setProperty('--fill', p.toFixed(4));
        if (pct >= 100) {
          dlEl.textContent = '';
          stateEl.innerHTML = MP.icons.svg('check', 15);
        } else {
          stateEl.textContent = '';
          // A file at 0% isn't stalled — every file in the torrent is wanted,
          // but the playing and next tracks are prioritised ahead of it, so a
          // track late in the album legitimately sits at zero for a while.
          // "0%" reads as broken; "Queued" is what's actually true.
          dlEl.textContent = pct === 0 ? 'Queued' : pct + '%';
        }
      },
      setSelected: function (selected) {
        el.classList.toggle('is-selected', selected);
        el.setAttribute('aria-selected', selected ? 'true' : 'false');
        el.tabIndex = selected ? 0 : -1;
      },
      setPlaying: function (isCurrent, isPaused) {
        el.classList.toggle('is-playing', isCurrent);
        el.classList.toggle('is-paused', isCurrent && isPaused);
        if (isCurrent) el.setAttribute('aria-current', 'true');
        else el.removeAttribute('aria-current');
      },
      setVisible: function (visible) {
        el.hidden = !visible;
      },
      destroy: function () {
        el.remove();
      },
    };

    api.updateLength();
    api.updateProgress();
    return api;
  }

  function clearRows() {
    rows.forEach(function (r) { r.destroy(); });
    rows.clear();
  }

  function applyFilter() {
    var q = MP.store.state.ui.filter.trim().toLowerCase();
    var visible = 0;
    rows.forEach(function (row) {
      var match = !q || row.name.toLowerCase().indexOf(q) !== -1;
      row.setVisible(match);
      if (match) visible++;
    });
    return visible;
  }

  function refreshProgress() {
    rows.forEach(function (row) { row.updateProgress(); });
  }

  function paintPlaying() {
    var pb = MP.store.state.playback;
    rows.forEach(function (row) {
      var isCurrent = pb.torrentId === currentId && pb.fileIndex === row.index;
      row.setPlaying(isCurrent, !pb.isPlaying);
    });
  }

  function render(id) {
    if (unsubProgress) {
      unsubProgress();
      unsubProgress = null;
    }
    clearRows();
    skeletonCaption = null;
    currentId = id;
    focusedIndex = 0;

    var t = id ? MP.store.getTorrent(id) : null;
    renderedCount = t && t.files ? t.files.length : 0;

    if (!t) {
      headEl.hidden = true;
      MP.empty.render(listEl, {
        glyph: 'music',
        title: 'Nothing in your library yet',
        body: 'Paste a magnet link and the tracks will stream as they download — no need to wait for the whole file.',
        action: { label: 'Add magnet', onClick: function () { MP.dialogs.openAddMagnet(); } },
      });
      return;
    }

    if (!t.files || t.files.length === 0) {
      headEl.hidden = true;
      var sk = MP.empty.skeleton(listEl, 8);
      skeletonCaption = sk.caption;
      skeletonStartedAt = performance.now();
      updateSkeletonCaption(t);
      offerLocalFolder(id, sk.el);
      unsubProgress = MP.store.subscribe('torrent:progress:' + id, updateSkeletonCaption);
      return;
    }

    // Only bail out when there's no media at all. A torrent full of formats we
    // can't decode still lists them — seeing "Unsupported" beside real track
    // names is more useful than an empty pane.
    if (!t.files.some(MP.util.isMediaFile)) {
      headEl.hidden = true;
      MP.empty.render(listEl, {
        glyph: 'alert',
        title: 'No audio or video in this torrent',
        body: 'This torrent contains no media files this player can list. You can still open the folder to see what it holds.',
        action: { label: 'Reveal in Finder', onClick: function () { MP.actions.openTorrentFolder(id); } },
      });
      return;
    }

    listEl.textContent = '';
    headEl.hidden = false;

    // Only media is listed. Images become the album artwork, and everything
    // else — cue sheets, rip logs, .accurip/.toc checksums, readmes — is
    // packaging, not tracks. Numbering stays contiguous over what's shown.
    var ordinal = 0;
    var first = null;
    var hidden = 0;
    t.files.forEach(function (file, index) {
      if (!MP.util.isMediaFile(file)) {
        if (!MP.util.isImageFile(file)) hidden++;
        return;
      }
      ordinal++;
      var row = createRow(t, file, index, ordinal);
      rows.set(index, row);
      listEl.appendChild(row.el);
      if (first === null) first = index;
    });

    if (hidden) listEl.appendChild(buildHiddenNote(hidden, id));

    if (first !== null) rows.get(first).setSelected(true);
    focusedIndex = first === null ? 0 : first;
    applyFilter();
    paintPlaying();
    unsubProgress = MP.store.subscribe('torrent:progress:' + id, refreshProgress);
  }

  var SWARM_TIMEOUT_MS = 25000;

  /**
   * Hidden files are still on disk, so say how many rather than making them
   * vanish without a trace.
   */
  function buildHiddenNote(count, torrentId) {
    var note = MP.util.el('li', 'tracklist__note');
    note.appendChild(
      MP.util.el('span', null, count + (count === 1 ? ' other file' : ' other files') + ' — cue sheets, logs and checksums')
    );
    var reveal = MP.util.el('button', 'btn btn--ghost', 'Reveal in Finder');
    reveal.type = 'button';
    reveal.addEventListener('click', function () {
      MP.actions.openTorrentFolder(torrentId);
    });
    note.appendChild(reveal);
    return note;
  }

  function updateSkeletonCaption(t) {
    if (!skeletonCaption) return;
    var peers = t && t.numPeers ? t.numPeers : 0;
    if (peers) {
      skeletonCaption.textContent =
        'Fetching metadata from ' + peers + (peers === 1 ? ' peer' : ' peers') + '…';
      return;
    }
    // A magnet carries no file list, so with no peers there is genuinely
    // nothing to show. Say so rather than spinning forever.
    var waited = performance.now() - skeletonStartedAt;
    skeletonCaption.textContent =
      waited > SWARM_TIMEOUT_MS
        ? 'No peers found. This torrent’s swarm looks offline — the tracks will appear as soon as someone connects.'
        : 'Looking for peers…';
  }

  /**
   * If the album is already sitting in the downloads folder, offer to open it
   * from there. A dead swarm can never supply the file list, but the files
   * themselves are right here.
   */
  function offerLocalFolder(id, container) {
    window.playerAPI.checkLocalFolder(id).then(function (info) {
      // Bail if the user has moved on or metadata arrived in the meantime.
      if (!info.available || currentId !== id || !container.isConnected) return;

      var wrap = MP.util.el('div', 'skeleton__rescue');
      wrap.appendChild(
        MP.util.el(
          'p',
          'skeleton__caption',
          'These ' + info.trackCount + ' tracks are already downloaded to your Music folder.'
        )
      );
      var btn = MP.util.el('button', 'btn btn--secondary', 'Open from Downloaded Files');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Checking files…';
        window.playerAPI.loadFromDisk(id).then(function (r) {
          if (r && r.error) {
            btn.disabled = false;
            btn.textContent = 'Open from Downloaded Files';
            MP.toast.error('Could not open from disk: ' + r.error);
          }
          // On success `torrent-ready` repopulates the list on its own.
        });
      });
      wrap.appendChild(btn);
      container.appendChild(wrap);
    });
  }

  function selectIndex(index) {
    var row = rows.get(index);
    if (!row || row.el.hidden) return;
    rows.forEach(function (r) { r.setSelected(false); });
    row.setSelected(true);
    focusedIndex = index;
    row.el.focus();
    row.el.scrollIntoView({ block: 'nearest' });
  }

  function visibleIndices() {
    var out = [];
    rows.forEach(function (row, index) {
      if (!row.el.hidden) out.push(index);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function moveSelection(delta) {
    var vis = visibleIndices();
    if (!vis.length) return;
    var at = vis.indexOf(focusedIndex);
    var next = MP.util.clamp((at < 0 ? 0 : at) + delta, 0, vis.length - 1);
    selectIndex(vis[next]);
  }

  function playIndex(index) {
    var row = rows.get(index);
    if (!row) return;
    if (!row.playable) {
      MP.toast.error('“' + row.name + '” is in a format this player can’t decode.', {
        action: { label: 'Reveal in Finder', onClick: function () { MP.actions.openTorrentFolder(currentId); } },
      });
      return;
    }
    MP.player.play(currentId, index);
  }

  function onTypeahead(ch) {
    clearTimeout(typeahead.timer);
    typeahead.buffer += ch.toLowerCase();
    typeahead.timer = setTimeout(function () { typeahead.buffer = ''; }, 700);
    var vis = visibleIndices();
    for (var i = 0; i < vis.length; i++) {
      var row = rows.get(vis[i]);
      if (row.name.toLowerCase().indexOf(typeahead.buffer) === 0) {
        selectIndex(vis[i]);
        return;
      }
    }
  }

  function init() {
    listEl = document.getElementById('track-list');
    headEl = document.getElementById('tracklist-head');
    bannerEl = document.getElementById('torrent-banner');
    bannerText = bannerEl.querySelector('.banner__text');
    bannerEl.querySelector('.banner__dismiss').addEventListener('click', function () {
      bannerEl.hidden = true;
    });

    // Single click selects, double click plays — the Music.app convention.
    listEl.addEventListener('click', function (e) {
      var row = e.target.closest('.track-row');
      if (!row) return;
      var index = Number(row.dataset.index);
      if (e.target.closest('.track-row__play')) {
        playIndex(index);
        return;
      }
      selectIndex(index);
    });

    listEl.addEventListener('dblclick', function (e) {
      var row = e.target.closest('.track-row');
      if (row) playIndex(Number(row.dataset.index));
    });

    listEl.addEventListener('contextmenu', function (e) {
      var row = e.target.closest('.track-row');
      if (!row) return;
      e.preventDefault();
      var index = Number(row.dataset.index);
      selectIndex(index);
      MP.menu.open(
        { x: e.clientX, y: e.clientY },
        [
          { label: 'Play', onClick: function () { playIndex(index); } },
          { label: 'Play Next', onClick: function () { MP.player.playNextUp(currentId, index); } },
          '-',
          { label: 'Reveal in Finder', onClick: function () { MP.actions.openTorrentFolder(currentId); } },
          { label: 'Copy File Name', onClick: function () { navigator.clipboard.writeText(rows.get(index).name).catch(function () {}); } },
        ],
        'track:' + index
      );
    });

    listEl.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
        case 'ArrowUp': e.preventDefault(); moveSelection(-1); break;
        case 'PageDown': e.preventDefault(); moveSelection(8); break;
        case 'PageUp': e.preventDefault(); moveSelection(-8); break;
        case 'Home': e.preventDefault(); moveSelection(-9999); break;
        case 'End': e.preventDefault(); moveSelection(9999); break;
        case 'Enter': e.preventDefault(); playIndex(focusedIndex); break;
        default:
          if (e.key.length === 1 && /\S/.test(e.key)) onTypeahead(e.key);
      }
    });

    MP.store.subscribe('selection', function (id) {
      bannerEl.hidden = true;
      render(id);
    });
    MP.store.subscribe('filter', applyFilter);
    MP.store.subscribe('playback:track', paintPlaying);
    MP.store.subscribe('playback:state', paintPlaying);
    MP.store.subscribe('durations', function () {
      rows.forEach(function (r) { r.updateLength(); });
    });
    MP.store.subscribe('torrents:list', function () {
      // Metadata arriving is what turns the skeleton into a real list.
      var t = currentId ? MP.store.getTorrent(currentId) : null;
      var count = t && t.files ? t.files.length : 0;
      if (count !== renderedCount) render(currentId);
    });

    render(MP.store.state.selectedTorrentId);
  }

  function showBanner(message) {
    bannerText.textContent = message;
    bannerEl.hidden = false;
  }

  function focusList() {
    var vis = visibleIndices();
    if (vis.length) selectIndex(vis[0]);
  }

  window.MP.tracklist = { init: init, showBanner: showBanner, focusList: focusList };
})();
