(function () {
  'use strict';

  function isTextTarget(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  var COMMANDS = {
    'play-pause': function () { MP.player.toggle(); },
    next: function () { MP.player.next(true); },
    prev: function () { MP.player.prev(); },
    'volume-up': function () { MP.player.setVolume(MP.store.state.playback.volume + 0.05); },
    'volume-down': function () { MP.player.setVolume(MP.store.state.playback.volume - 0.05); },
    mute: function () { MP.player.toggleMute(); },
    shuffle: function () { MP.player.setShuffle(!MP.store.state.playback.shuffle); },
    repeat: function () { MP.player.cycleRepeat(); },
    'add-magnet': function () { MP.dialogs.openAddMagnet(); },
    settings: function () { MP.dialogs.openSettings(); },
    shortcuts: function () { MP.dialogs.openShortcuts(); },
    'cycle-theme': function () {
      MP.theme.cycle();
      MP.toast.show('Theme: ' + MP.theme.get());
    },
    'focus-filter': function () {
      var input = document.getElementById('filter-input');
      input.focus();
      input.select();
    },
    'reveal-downloads': function () { MP.actions.openDownloadFolder(); },
    'remove-torrent': function () {
      var id = MP.store.state.selectedTorrentId;
      if (id) MP.actions.removeTorrent(id, false);
    },
    'reveal-torrent': function () {
      var id = MP.store.state.selectedTorrentId;
      if (id) MP.actions.openTorrentFolder(id);
    },
    fullscreen: function () { MP.player.toggleFullscreen(); },
  };

  function run(command) {
    var fn = COMMANDS[command];
    if (fn) fn();
  }

  function onKeydown(e) {
    // Dialogs own their own keyboard handling; text fields own theirs.
    if (MP.dialogs.anyOpen()) {
      if (e.key === '?' && !isTextTarget(e.target)) return;
      return;
    }

    var typing = isTextTarget(e.target);
    var mod = e.metaKey || e.ctrlKey;

    if (mod) {
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); return run('next');
        case 'ArrowLeft': e.preventDefault(); return run('prev');
        case 'ArrowUp': e.preventDefault(); return run('volume-up');
        case 'ArrowDown': e.preventDefault(); return run('volume-down');
      }
      return; // everything else with a modifier belongs to the app menu
    }

    if (e.key === 'Escape') {
      if (typing) {
        e.target.blur();
        MP.store.setFilter('');
        e.target.value = '';
      }
      return;
    }

    if (typing) return;

    switch (e.key) {
      case ' ':
        // Space would otherwise re-trigger whatever button has focus.
        e.preventDefault();
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        run('play-pause');
        break;
      case 'ArrowRight':
        e.preventDefault();
        MP.player.seekBy(e.shiftKey ? 30 : 10);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        MP.player.seekBy(e.shiftKey ? -30 : -10);
        break;
      case 'm': case 'M': run('mute'); break;
      case 's': case 'S': run('shuffle'); break;
      case 'r': case 'R': run('repeat'); break;
      case 'f': case 'F': run('fullscreen'); break;
      case '?': run('shortcuts'); break;
    }
  }

  function init() {
    document.addEventListener('keydown', onKeydown);
    // The macOS app menu dispatches the same command names, so accelerators
    // work regardless of what has focus.
    MP.api.on('menu-command', run);
  }

  window.MP.shortcuts = { init: init, run: run };
})();
