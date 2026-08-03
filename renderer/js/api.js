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

  /**
   * The buffer is capped and self-releasing, because "buffered until ready()" is
   * only safe if ready() is guaranteed — and it is not. `main.js` skips ready()
   * on any startup failure, and main pushes a torrent-progress payload per
   * torrent per second regardless. A boot error therefore turned this array into
   * an unbounded leak that grew for as long as the window stayed open, showing a
   * broken UI the whole time.
   *
   * Dropping the oldest is right for the only event that can realistically flood
   * it: a stale progress tick is worthless, and the newest one is the truth.
   */
  var QUEUE_MAX = 500;
  var READY_WATCHDOG_MS = 15000;

  var handlers = {};
  var queue = [];
  var isReady = false;
  var dropped = 0;
  var watchdog = null;

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
      if (queue.length > QUEUE_MAX) {
        queue.shift();
        // Once, not per drop — this fires at the tick rate.
        if (dropped++ === 0) {
          console.warn(
            '[api] event buffer hit ' + QUEUE_MAX + ' before ready() — dropping oldest. ' +
              'Boot probably failed; the watchdog will release the buffer.'
          );
        }
      }
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
    // If boot never reaches ready(), release the buffer anyway rather than
    // accumulating forever behind a UI that is already broken.
    watchdog = setTimeout(function () {
      if (isReady) return;
      console.warn('[api] ready() not called within ' + READY_WATCHDOG_MS + 'ms — releasing buffer');
      ready();
    }, READY_WATCHDOG_MS);

    api.onTorrentReady(function (d) { dispatch('torrent-ready', d); });
    api.onTorrentProgress(function (d) { dispatch('torrent-progress', d); });
    api.onTorrentError(function (d) { dispatch('torrent-error', d); });
    api.onRestoreMagnets(function (d) { dispatch('restore-magnets', d); });
    api.onLibraryUnavailable(function (d) { dispatch('library-unavailable', d); });
    api.onMenuCommand(function (d) { dispatch('menu-command', d); });
  }

  function ready() {
    if (isReady) return;
    isReady = true;
    clearTimeout(watchdog);
    watchdog = null;
    var pending = queue;
    queue = [];
    pending.forEach(function (entry) { dispatch(entry[0], entry[1]); });
  }

  window.MP.api = { install: install, on: on, ready: ready };
})();
