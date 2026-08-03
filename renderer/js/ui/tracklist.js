(function () {
  'use strict';

  var listEl, headEl, bannerEl, bannerText;
  var rows = new Map(); // fileIndex -> row component
  var currentId = null;
  var unsubProgress = null;
  var focusedIndex = 0;
  // Which row currently carries the selection, so it can be cleared without
  // walking every row. null means nothing is selected.
  var selectedIndex = null;
  // Which row currently shows as playing, for the same reason.
  var playingIndex = null;
  var skeletonCaption = null;
  var skeletonStartedAt = 0;
  var renderedCount = -1; // file count the current DOM reflects
  var typeahead = { buffer: '', timer: null };

  // Album sections. `groupOf` maps a file index to its group key so the filter
  // and the playing-track highlight can find a row's section in O(1).
  var groups = new Map(); // groupKey -> group component
  var groupOf = new Map(); // fileIndex -> groupKey
  // Collapse state per torrent, kept at module scope so it survives render(),
  // which rebuilds the list wholesale every time the file count moves. Losing
  // every open section to a metadata tick would make the list feel unreliable.
  // In memory only: collapse is a browsing posture, not a preference.
  var collapsedByTorrent = new Map(); // torrentId -> Set(groupKey)
  var touchedTorrents = new Set(); // user has hand-adjusted these; stop auto-collapsing

  // Four albums and their tracks still fit on screen. Above that the list is a
  // wall you have to scroll past to find anything, so it becomes an index.
  var AUTO_COLLAPSE_ABOVE = 4;

  function collapsedSet(torrentId) {
    if (!collapsedByTorrent.has(torrentId)) collapsedByTorrent.set(torrentId, new Set());
    return collapsedByTorrent.get(torrentId);
  }

  /** Visible means the row is shown AND its album isn't collapsed. */
  function isRowVisible(el) {
    if (el.hidden) return false;
    return !(el.parentNode && el.parentNode.hidden);
  }

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
    groups.clear();
    groupOf.clear();
    invalidateVisible();
    // The rows these pointed at no longer exist.
    selectedIndex = null;
    playingIndex = null;
  }

  /**
   * Filtering and collapsing are kept separate on purpose.
   *
   * Collapse hides a whole group's `<ul>` body in one move; the filter hides
   * individual rows. If both drove `row.setVisible` they would overwrite each
   * other, and a match inside a collapsed album would be unreachable. So while
   * a query is active every group is force-expanded — a hit you cannot see
   * reads as no hit at all — and the prior collapse state is restored the
   * moment the field is cleared.
   */
  function applyFilter() {
    // The one choke point for every visibility change — row filtering and group
    // collapse both land here — so it is the only place the visible-index cache
    // needs invalidating.
    invalidateVisible();

    var q = MP.store.state.ui.filter.trim().toLowerCase();
    var collapsed = collapsedSet(currentId);
    var hits = new Map();
    var visible = 0;

    rows.forEach(function (row) {
      var match = !q || row.name.toLowerCase().indexOf(q) !== -1;
      row.setVisible(match);
      if (!match) return;
      visible++;
      var key = groupOf.get(row.index);
      if (key !== undefined) hits.set(key, (hits.get(key) || 0) + 1);
    });

    groups.forEach(function (g, key) {
      var n = hits.get(key) || 0;
      // A header stranded over an album with no matches reads as a broken
      // filter, so the whole group goes.
      g.setVisible(!q || n > 0);
      g.setCollapsed(q ? false : collapsed.has(key));
      g.setMatchCount(q ? n : null);
    });

    return visible;
  }

  function toggleGroup(key) {
    var collapsed = collapsedSet(currentId);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    touchedTorrents.add(currentId);
    applyFilter();
    // Selection may have been sitting inside the section that just closed.
    var focused = rows.get(focusedIndex);
    if (focused && !isRowVisible(focused.el)) {
      var vis = visibleIndices();
      if (vis.length) selectIndex(vis[0]);
    }
  }

  /**
   * An album section: a `role="group"` wrapper holding a head and a `<ul>` of
   * rows.
   *
   * The nested list is what makes collapsing cheap and correct — one `hidden`
   * on the body rather than a flag on each of two hundred rows, and it leaves
   * the filter as the sole owner of per-row visibility. It is also the ARIA
   * shape a listbox actually permits: a bare `<li>` header among `role="option"`
   * siblings is invalid, whereas a listbox may contain groups.
   */
  function createGroup(torrent, info, ordinal) {
    var el = MP.util.el('li', 'tgroup');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', info.name);

    var head = MP.util.el('div', 'tgroup__head');
    head.setAttribute('role', 'presentation');

    var bodyId = 'tgroup-body-' + ordinal;
    var toggle = MP.util.el('button', 'tgroup__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-controls', bodyId);

    var chev = MP.util.el('span', 'tgroup__chev');
    MP.icons.set(chev, 'chevron', 14);
    toggle.appendChild(chev);
    toggle.appendChild(MP.util.el('span', 'tgroup__name truncate', info.name));
    var metaEl = MP.util.el('span', 'tgroup__meta tnum');
    toggle.appendChild(metaEl);
    toggle.addEventListener('click', function () { toggleGroup(info.key); });

    var actions = MP.util.el('span', 'tgroup__actions');
    var playBtn = MP.util.el('button', 'icon-btn tgroup__play');
    playBtn.type = 'button';
    playBtn.setAttribute('aria-label', 'Play ' + info.name);
    MP.icons.set(playBtn, 'play', 14);
    playBtn.addEventListener('click', function () {
      // Plays from this album's first track using the ordinary whole-torrent
      // queue, so it rolls on into the next album at the end. A queue that
      // stopped dead at an album boundary would read as a bug in a player that
      // otherwise always auto-advances.
      MP.player.play(torrent.id, info.indices[0]);
    });
    var shuffleBtn = MP.util.el('button', 'icon-btn tgroup__shuffle');
    shuffleBtn.type = 'button';
    shuffleBtn.setAttribute('aria-label', 'Shuffle ' + info.name);
    MP.icons.set(shuffleBtn, 'shuffle', 14);
    shuffleBtn.addEventListener('click', function () {
      // Scoped, unlike Play: shuffling 221 tracks from a button labelled with
      // one album's name would be a lie about what the button does.
      MP.player.playScoped(torrent.id, info.indices, true);
    });
    actions.appendChild(playBtn);
    actions.appendChild(shuffleBtn);

    head.appendChild(toggle);
    head.appendChild(actions);

    var body = MP.util.el('ul', 'tgroup__body');
    body.id = bodyId;
    body.setAttribute('role', 'presentation');

    el.appendChild(head);
    el.appendChild(body);

    var countLabel = info.indices.length + (info.indices.length === 1 ? ' track' : ' tracks');
    var bytes = 0;
    info.indices.forEach(function (i) { bytes += (torrent.files[i] || {}).length || 0; });
    var lastPct = -1;

    var api = {
      el: el,
      body: body,
      key: info.key,
      indices: info.indices,
      setVisible: function (on) { el.hidden = !on; },
      setCollapsed: function (on) {
        body.hidden = !!on;
        el.classList.toggle('is-collapsed', !!on);
        toggle.setAttribute('aria-expanded', on ? 'false' : 'true');
      },
      isCollapsed: function () { return !!body.hidden; },
      setMatchCount: function (n) {
        api._match = n;
        api.updateProgress(true);
      },
      /**
       * Length-weighted, not a plain mean: a forty-second interlude should not
       * count as much as a ten-minute track. Guarded on the rounded percent so
       * the 1 Hz tick doesn't touch the DOM for nothing.
       */
      updateProgress: function (force) {
        // `bytes` above is the same sum, computed once when the group was built —
        // the total cannot change without the list being rebuilt, so recomputing
        // it per tick was pure waste.
        var got = 0;
        info.indices.forEach(function (i) {
          got += MP.store.fileProgress(torrent.id, i) * ((torrent.files[i] || {}).length || 0);
        });
        var pct = bytes ? Math.round((got / bytes) * 100) : 0;
        if (!force && pct === lastPct) return;
        lastPct = pct;
        var right = pct >= 100 ? 'Downloaded' : pct === 0 ? 'Queued' : pct + '%';
        metaEl.textContent = api._match != null
          ? api._match + ' of ' + countLabel + ' matching'
          : countLabel + ' · ' + MP.util.formatBytes(bytes) + ' · ' + right;
      },
    };
    api._match = null;
    api.updateProgress(true);
    return api;
  }

  // The last fileProgress array we painted from, by identity. The store carries
  // the previous array forward unchanged whenever a tick omits per-file numbers
  // (which is three ticks in four, and all ticks for a torrent that isn't on
  // screen), so reference equality is an exact test for "nothing to repaint".
  var paintedFileProgress = null;

  function refreshProgress(torrent) {
    // Rows and group headers each walk every file, so an unguarded refresh was
    // two full passes over the whole tracklist per second — computing, on most
    // ticks, numbers identical to the ones already on screen. The per-row lastPct
    // guards suppressed the DOM writes but not any of the work.
    var fp = torrent && torrent.fileProgress;
    if (fp && fp === paintedFileProgress) return;
    paintedFileProgress = fp || null;

    rows.forEach(function (row) { row.updateProgress(); });
    groups.forEach(function (g) { g.updateProgress(); });
  }

  function paintPlaying() {
    var pb = MP.store.state.playback;
    var nowPlaying =
      pb.torrentId === currentId && pb.fileIndex != null ? pb.fileIndex : null;

    // Two rows at most, not all of them. This fires on every track change *and*
    // every play/pause, and the all-rows version made a pause into an O(n) style
    // invalidation over the whole list.
    if (playingIndex !== null && playingIndex !== nowPlaying) {
      var prev = rows.get(playingIndex);
      if (prev) prev.setPlaying(false, !pb.isPlaying);
    }
    if (nowPlaying !== null) {
      var row = rows.get(nowPlaying);
      if (row) row.setPlaying(true, !pb.isPlaying);
    }
    playingIndex = nowPlaying;

    // Open the album that's playing. Pressing Play on a collapsed section and
    // having it stay shut — with no visible sign of which track started —
    // reads as the button not working. Only fires on a track change, so
    // deliberately collapsing an album mid-play still sticks.
    if (pb.torrentId !== currentId || pb.fileIndex == null) return;
    var g = groups.get(groupOf.get(pb.fileIndex));
    if (g && g.isCollapsed()) {
      collapsedSet(currentId).delete(g.key);
      applyFilter();
    }
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

    // A discography arrives as one flat list of hundreds of tracks. The
    // torrent's own folder names already say which record each belongs to, so
    // split on that — no tags, no downloaded bytes, correct from the moment
    // metadata lands. Falls back to the plain list for a single-album torrent.
    var plan = MP.albums.group(t);
    var byIndex = new Map();
    if (plan.grouped) {
      plan.groups.forEach(function (info, n) {
        var g = createGroup(t, info, n);
        groups.set(info.key, g);
        listEl.appendChild(g.el);
        info.indices.forEach(function (i) {
          groupOf.set(i, info.key);
          byIndex.set(i, g.body);
        });
      });
    }

    // Only media is listed. Images become the album artwork, and everything
    // else — cue sheets, rip logs, .accurip/.toc checksums, readmes — is
    // packaging, not tracks.
    var ordinal = 0;
    var perGroup = new Map();
    var first = null;
    var hidden = 0;
    t.files.forEach(function (file, index) {
      if (!MP.util.isMediaFile(file)) {
        if (!MP.util.isImageFile(file)) hidden++;
        return;
      }
      // Numbering restarts inside each album: the "#" column means the track's
      // place on that record, and counting to 221 across a discography says
      // nothing. Ungrouped lists stay contiguous exactly as before.
      var n;
      if (plan.grouped) {
        var key = groupOf.get(index);
        n = (perGroup.get(key) || 0) + 1;
        perGroup.set(key, n);
      } else {
        n = ++ordinal;
      }
      var row = createRow(t, file, index, n);
      rows.set(index, row);
      (byIndex.get(index) || listEl).appendChild(row.el);
      if (first === null) first = index;
    });

    if (hidden) listEl.appendChild(buildHiddenNote(hidden, id));

    if (plan.grouped) applyCollapsePolicy(id, plan);

    if (first !== null) rows.get(first).setSelected(true);
    selectedIndex = first;
    focusedIndex = first === null ? 0 : first;
    // A fresh list has nothing painted yet, so the identity guard in
    // refreshProgress must not short-circuit the first paint.
    paintedFileProgress = null;
    applyFilter();
    paintPlaying();
    unsubProgress = MP.store.subscribe('torrent:progress:' + id, refreshProgress);
  }

  /**
   * Decide what starts open. Small torrents behave exactly as they always have;
   * a discography opens as a short, scannable index instead of a wall. Once the
   * user has opened or closed anything themselves we stop second-guessing them.
   */
  function applyCollapsePolicy(torrentId, plan) {
    if (touchedTorrents.has(torrentId)) return;
    var collapsed = collapsedSet(torrentId);
    collapsed.clear();
    if (plan.groups.length <= AUTO_COLLAPSE_ABOVE) return;

    var pb = MP.store.state.playback;
    var playingKey = pb.torrentId === torrentId ? groupOf.get(pb.fileIndex) : undefined;
    plan.groups.forEach(function (info) {
      if (info.key !== playingKey) collapsed.add(info.key);
    });
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
    // Focusing inside a collapsed album is a no-op, so open it first — this is
    // how the playing track stays reachable when its section is shut.
    var g = groups.get(groupOf.get(index));
    if (g && g.isCollapsed()) {
      collapsedSet(currentId).delete(g.key);
      applyFilter();
    }
    // Clear exactly the row that was selected rather than sweeping all of them.
    // This runs on every click and every arrow key, and each setSelected() does a
    // class toggle plus a setAttribute and a tabIndex write — so at 242 rows a
    // single arrow press was ~242 style invalidations to move one highlight.
    if (selectedIndex !== null && selectedIndex !== index) {
      var prev = rows.get(selectedIndex);
      if (prev) prev.setSelected(false);
    }
    row.setSelected(true);
    selectedIndex = index;
    focusedIndex = index;
    row.el.focus();
    row.el.scrollIntoView({ block: 'nearest' });
  }

  /**
   * DOM order, not file-index order.
   *
   * Once albums exist, arrow keys have to walk what is actually on screen: a
   * collapsed album must be skipped whole, which a sorted list of file indices
   * cannot express. Reading the DOM also keeps navigation honest for free if
   * the visual order ever stops matching file order.
   *
   * Cached, because this is called on every arrow key and every typeahead
   * keystroke, and the uncached version ran querySelectorAll over the whole list
   * and allocated a fresh array each time. Invalidated by anything that can
   * change what is on screen: render(), the filter, and collapse toggles — see
   * invalidateVisible().
   */
  var visibleCache = null;

  function invalidateVisible() {
    visibleCache = null;
  }

  function visibleIndices() {
    if (visibleCache) return visibleCache;
    var out = [];
    var nodes = listEl.querySelectorAll('.track-row');
    for (var i = 0; i < nodes.length; i++) {
      if (!isRowVisible(nodes[i])) continue;
      out.push(Number(nodes[i].dataset.index));
    }
    visibleCache = out;
    return out;
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
      // Group buttons live inside the list; let them keep their own key
      // handling instead of hijacking arrows for row selection.
      if (e.target.closest && e.target.closest('.tgroup__head')) return;
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
    MP.store.subscribe('torrents:list', function (order) {
      // Browsing state for torrents that no longer exist. Small per entry, but it
      // is keyed by torrent id and nothing ever released it, so it grew for the
      // life of the window every time an album was removed.
      var live = new Set(order || []);
      collapsedByTorrent.forEach(function (_, id) {
        if (!live.has(id)) collapsedByTorrent.delete(id);
      });
      touchedTorrents.forEach(function (id) {
        if (!live.has(id)) touchedTorrents.delete(id);
      });

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
