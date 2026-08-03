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
    MP.store.state.settings.uploadLimit = prefs.uploadLimit != null ? prefs.uploadLimit : 1500000;
    MP.store.state.settings.pieceStrategy = prefs.pieceStrategy || 'auto';
    MP.store.state.settings.showNetPanel = !!prefs.showNetPanel;
    MP.store.state.settings.expectedPath = prefs.expectedPath || 'auto';
    MP.store.state.settings.homeNetwork = prefs.homeNetwork || null;
    MP.store.state.settings.peerEncryption = prefs.peerEncryption !== false;
    MP.store.state.settings.enableUtp = prefs.enableUtp === true;
    MP.store.state.settings.torrentPort = prefs.torrentPort || null;
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

  /**
   * Say so when the last session died.
   *
   * A native crash leaves no trace in the UI: the app vanishes, you reopen it,
   * and it behaves as though nothing happened — which is why this went
   * undiagnosed for so long. One toast, only when it actually happened.
   */
  function reportLastCrash() {
    if (!window.playerAPI.getLastCrash) return;
    window.playerAPI.getLastCrash().then(function (info) {
      if (!info) return;
      var native = info.dumps && info.dumps.length;
      MP.toast.show(
        native
          ? 'The app crashed last session' + (info.utp ? ' with µTP enabled' : '') + '. Details written to errors.log.'
          : 'The app closed unexpectedly last session. Details written to errors.log.',
        {
          duration: 12000,
          action: { label: 'Show log', onClick: function () { window.playerAPI.openLogsFolder(); } },
        }
      );
    }).catch(function () {});
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
        // Last, so a crash notice doesn't compete with the library loading in.
        reportLastCrash();
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
