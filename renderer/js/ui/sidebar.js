(function () {
  'use strict';

  var listEl = null;
  var countEl = null;
  var rows = new Map(); // id -> row component
  var progressSubs = new Map(); // id -> unsubscribe

  /**
   * A keyed row component: created once, updated in place, destroyed when the
   * torrent goes away. Nothing here is ever rebuilt from a string, and the row
   * binds no listeners of its own — selection is handled by one delegated
   * listener on the <ul>.
   */
  function createRow(torrent) {
    var el = MP.util.tpl('#tpl-torrent-row');
    el.dataset.id = torrent.id;
    var nameEl = el.querySelector('.torrent-row__name');
    var statusEl = el.querySelector('.torrent-row__status');
    var fillEl = el.querySelector('.torrent-row__meter .meter__fill');
    var moreBtn = el.querySelector('.torrent-row__more');
    MP.icons.set(moreBtn, 'more', 16);
    moreBtn.setAttribute('aria-label', 'Actions for this torrent');

    var lastStatus = '';
    var lastPct = -1;

    function statusText(t) {
      if (t.pending) return 'Fetching metadata…';
      var count = t.mediaCount != null ? t.mediaCount : t.files ? t.files.length : 0;
      var tracks = count === 1 ? '1 track' : count + ' tracks';
      if (t.done) {
        return tracks + ' · Done' + (t.length ? ' · ' + MP.util.formatBytes(t.length) : '');
      }
      if (!t.numPeers) return tracks + ' · Connecting…';
      return tracks + ' · ' + Math.round((t.progress || 0) * 100) + '% · ' + MP.util.formatSpeed(t.downloadSpeed);
    }

    var api = {
      el: el,
      id: torrent.id,
      updateMeta: function (t) {
        nameEl.textContent = t.name || t.id;
        nameEl.title = t.name || t.id;
        el.classList.toggle('is-done', !!t.done);
        el.classList.toggle('is-pending', !!t.pending);
      },
      updateProgress: function (t) {
        // Early-out on the rounded values. This used to be an optimisation for
        // mostly-frozen rows; now that the whole torrent downloads rather than
        // just the playing track, every row moves every tick and this is doing
        // real work — a percent only changes so often.
        var pct = Math.round((t.progress || 0) * 100);
        var status = statusText(t);
        if (pct === lastPct && status === lastStatus) return;
        lastPct = pct;
        lastStatus = status;
        statusEl.textContent = status;
        fillEl.style.setProperty('--fill', (t.progress || 0).toFixed(4));
      },
      setSelected: function (selected) {
        el.classList.toggle('is-selected', selected);
        el.setAttribute('aria-selected', selected ? 'true' : 'false');
        el.tabIndex = selected ? 0 : -1;
      },
      destroy: function () {
        el.remove();
      },
    };

    api.updateMeta(torrent);
    api.updateProgress(torrent);
    return api;
  }

  function openRowMenu(id, at) {
    var t = MP.store.getTorrent(id);
    if (!t) return;

    var items = [
      { label: 'Play All', onClick: function () { MP.store.select(id); MP.player.playAll(id, false); } },
      { label: 'Shuffle Play', onClick: function () { MP.store.select(id); MP.player.playAll(id, true); } },
      '-',
    ];

    // Lifecycle, offered only when it would do something. A completed album stops
    // seeding once its grace window expires, so Seed is the way back into the swarm;
    // an incomplete album that isn't live is queued behind the live-torrent cap.
    if (t.live === false) {
      items.push(
        t.done
          ? { label: 'Seed This Album', onClick: function () { MP.actions.seedAlbum(id); } }
          : { label: 'Resume Download', onClick: function () { MP.actions.resumeAlbum(id); } }
      );
      items.push('-');
    }

    items.push(
      { label: 'Reveal in Finder', onClick: function () { MP.actions.openTorrentFolder(id); } },
      '-',
      { label: 'Remove from Library', danger: true, onClick: function () { MP.actions.removeTorrent(id, false); } },
      { label: 'Remove and Delete Files…', danger: true, onClick: function () { MP.actions.removeTorrent(id, true); } }
    );

    MP.menu.open(at, items, id);
  }

  function syncProgressSub(id) {
    if (progressSubs.has(id)) return;
    progressSubs.set(
      id,
      MP.store.subscribe('torrent:progress:' + id, function (t) {
        var row = rows.get(id);
        if (row) row.updateProgress(t);
      })
    );
  }

  function reconcile() {
    var order = MP.store.state.torrentOrder;
    var seen = new Set(order);

    rows.forEach(function (row, id) {
      if (!seen.has(id)) {
        row.destroy();
        rows.delete(id);
        var unsub = progressSubs.get(id);
        if (unsub) unsub();
        progressSubs.delete(id);
      }
    });

    if (order.length === 0) {
      if (!listEl.querySelector('.empty')) {
        MP.empty.render(listEl, {
          variant: 'sidebar',
          title: 'No torrents yet',
          body: 'Paste a magnet link to start streaming.',
          action: { label: 'Add magnet', onClick: function () { MP.dialogs.openAddMagnet(); } },
        });
      }
      countEl.textContent = '0';
      return;
    }

    var placeholder = listEl.querySelector('.empty');
    if (placeholder) placeholder.remove();

    order.forEach(function (id) {
      var torrent = MP.store.getTorrent(id);
      if (!torrent) return;
      var row = rows.get(id);
      if (!row) {
        row = createRow(torrent);
        rows.set(id, row);
        syncProgressSub(id);
      } else {
        row.updateMeta(torrent);
      }
      // appendChild MOVES an already-attached node, so this is a stable O(n)
      // reorder with zero teardown and zero listener rebinding.
      listEl.appendChild(row.el);
      row.setSelected(id === MP.store.state.selectedTorrentId);
    });

    countEl.textContent = String(order.length);
  }

  function onSelection(id) {
    rows.forEach(function (row, rowId) {
      row.setSelected(rowId === id);
    });
  }

  function focusRow(delta) {
    var order = MP.store.state.torrentOrder;
    if (!order.length) return;
    var i = order.indexOf(MP.store.state.selectedTorrentId);
    var next = MP.util.clamp((i < 0 ? 0 : i) + delta, 0, order.length - 1);
    MP.store.select(order[next]);
    var row = rows.get(order[next]);
    if (row) row.el.focus();
  }

  function init() {
    listEl = document.getElementById('torrent-list');
    countEl = document.getElementById('torrent-count');

    listEl.addEventListener('click', function (e) {
      var more = e.target.closest('.torrent-row__more');
      var row = e.target.closest('.torrent-row');
      if (!row) return;
      if (more) {
        var rect = more.getBoundingClientRect();
        openRowMenu(row.dataset.id, { x: rect.left - 168, y: rect.bottom + 4 });
        return;
      }
      MP.store.select(row.dataset.id);
    });

    listEl.addEventListener('contextmenu', function (e) {
      var row = e.target.closest('.torrent-row');
      if (!row) return;
      e.preventDefault();
      MP.store.select(row.dataset.id);
      openRowMenu(row.dataset.id, { x: e.clientX, y: e.clientY });
    });

    listEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusRow(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusRow(-1);
      } else if (e.key === 'Enter') {
        var row = e.target.closest('.torrent-row');
        if (row) {
          e.preventDefault();
          MP.store.select(row.dataset.id);
          document.getElementById('track-list').focus();
        }
      }
    });

    MP.store.subscribe('torrents:list', reconcile);
    MP.store.subscribe('selection', onSelection);
    reconcile();
  }

  window.MP.sidebar = { init: init };
})();
