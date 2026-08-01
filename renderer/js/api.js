(function () {
  'use strict';

  /**
   * The ONLY file permitted to call playerAPI.on*.
   *
   * Each channel is subscribed exactly once here and fanned out through a local
   * emitter that returns real unsubscribe functions. Subscribing twice would be
   * unrecoverable without a window reload — and `restore-magnets` calls
   * addTorrent per magnet, so a duplicate handler would add every saved torrent
   * twice on launch.
   *
   * Events are buffered until ready() is called. The initial getTorrents()
   * snapshot resolves after the subscriptions are installed, so without the
   * buffer a slow snapshot can clobber fresher tick data — invisible when
   * everything rerenders anyway, but a visible backwards jump once the lists
   * reconcile.
   */

  var handlers = {};
  var queue = [];
  var isReady = false;

  function on(event, fn) {
    if (!handlers[event]) handlers[event] = new Set();
    handlers[event].add(fn);
    return function () {
      handlers[event].delete(fn);
    };
  }

  function dispatch(event, payload) {
    if (!isReady) {
      queue.push([event, payload]);
      return;
    }
    var set = handlers[event];
    if (!set) return;
    set.forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[api] handler for "' + event + '" threw:', err);
      }
    });
  }

  function install() {
    var api = window.playerAPI;
    api.onTorrentReady(function (d) { dispatch('torrent-ready', d); });
    api.onTorrentProgress(function (d) { dispatch('torrent-progress', d); });
    api.onTorrentError(function (d) { dispatch('torrent-error', d); });
    api.onRestoreMagnets(function (d) { dispatch('restore-magnets', d); });
    api.onMenuCommand(function (d) { dispatch('menu-command', d); });
  }

  function ready() {
    isReady = true;
    var pending = queue;
    queue = [];
    pending.forEach(function (entry) { dispatch(entry[0], entry[1]); });
  }

  window.MP.api = { install: install, on: on, ready: ready };
})();
