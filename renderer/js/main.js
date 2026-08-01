(function () {
  'use strict';

  function showFatal(message) {
    var el = document.getElementById('fatal-error');
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
    console.error('[Player]', message);
  }

  function wireIpc() {
    MP.api.on('torrent-ready', function (data) {
      MP.store.upsertTorrent(data);
    });

    MP.api.on('torrent-progress', function (data) {
      MP.store.upsertTorrent(data);
    });

    MP.api.on('torrent-error', function (data) {
      var message = (data && data.message) || 'Unknown torrent error';
      MP.tracklist.showBanner(message);
      MP.toast.error(message);
    });

    MP.api.on('restore-magnets', function (magnets) {
      if (!Array.isArray(magnets) || !magnets.length) return;
      magnets.forEach(function (magnet) {
        var hash = MP.util.parseInfoHash(magnet);
        if (hash && MP.store.getTorrent(hash)) return;
        MP.actions.addMagnet(magnet, { silent: true, label: 'Restoring…' }).catch(function (err) {
          console.warn('[restore] could not add saved magnet:', err && err.message);
        });
      });
    });
  }

  function wireChrome() {
    document.getElementById('btn-add-magnet').addEventListener('click', function () {
      MP.dialogs.openAddMagnet();
    });
    document.getElementById('btn-settings').addEventListener('click', function () {
      MP.dialogs.openSettings();
    });
    document.getElementById('btn-downloads').addEventListener('click', function () {
      MP.actions.openDownloadFolder();
    });

    var filterInput = document.getElementById('filter-input');
    filterInput.addEventListener(
      'input',
      MP.util.debounce(function () {
        MP.store.setFilter(filterInput.value);
      }, 120)
    );

    // Drop a magnet anywhere in the window.
    document.body.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.body.addEventListener('drop', function (e) {
      e.preventDefault();
      var text = e.dataTransfer.getData('text');
      if (!text) return;
      MP.actions.addMagnet(text).catch(function (err) {
        MP.toast.error(err.message || String(err));
      });
    });
  }

  function seedSettings(prefs) {
    MP.store.state.settings.prefetch = prefs.prefetch !== false;
    MP.store.state.settings.readDurations = !!prefs.readDurations;
    if (prefs.durations) {
      Object.keys(prefs.durations).forEach(function (key) {
        MP.store.state.durations.set(key, prefs.durations[key]);
      });
    }
    return Promise.all([
      window.playerAPI.getDownloadPath(),
      window.playerAPI.getDefaultDownloadPath(),
      window.playerAPI.getAppVersion(),
    ]).then(function (values) {
      MP.store.state.settings.downloadPath = values[0];
      MP.store.state.settings.defaultDownloadPath = values[1];
      MP.store.state.settings.version = values[2];
    });
  }

  function boot() {
    if (!window.playerAPI) {
      showFatal('Player API not loaded. Run the app with Electron (npm start).');
      return;
    }

    MP.toast.init();
    MP.menu.init();
    MP.dialogs.init();
    MP.store._initDurationPersistence();

    // Subscribe to every IPC channel exactly once, before anything can arrive.
    // Events are buffered until ready() so the initial snapshot below can't be
    // clobbered by a tick that lands while it's in flight.
    MP.api.install();
    wireIpc();

    window.playerAPI
      .getPrefs()
      .then(function (prefs) {
        // Before player.init: play() consults MP.dsp for the crossOrigin decision.
        MP.dsp.init(prefs);
        MP.player.init(prefs);
        return seedSettings(prefs);
      })
      .then(function () {
        MP.sidebar.init();
        MP.torrentHeader.init();
        MP.tracklist.init();
        MP.transport.init();
        MP.dspPanel.init();
        MP.shortcuts.init();
        wireChrome();
        return window.playerAPI.getTorrents();
      })
      .then(function (list) {
        (list || []).forEach(function (t) { MP.store.upsertTorrent(t); });
        MP.api.ready();
      })
      .catch(function (err) {
        showFatal('Startup failed: ' + (err && err.message ? err.message : String(err)));
      });
  }

  window.addEventListener('error', function (e) {
    showFatal('Error: ' + (e.message || e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason && (e.reason.message || e.reason);
    showFatal('Unhandled error: ' + (reason || e));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
