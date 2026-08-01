(function () {
  'use strict';

  var THEMES = [
    { id: 'midnight', label: 'Midnight' },
    { id: 'daylight', label: 'Daylight' },
    { id: 'auto', label: 'Match System' },
  ];

  var listeners = [];
  var current = 'midnight';

  function isKnown(id) {
    return THEMES.some(function (t) { return t.id === id; });
  }

  /**
   * Applied before first paint. The theme arrives via a process argument rather
   * than IPC because `script-src 'self'` forbids the usual inline bootstrap and
   * an async round-trip would flash the wrong theme.
   */
  function init() {
    var boot = window.playerAPI && window.playerAPI.initialTheme;
    current = isKnown(boot) ? boot : 'midnight';
    document.documentElement.dataset.theme = current;
  }

  function get() {
    return current;
  }

  function set(id) {
    if (!isKnown(id) || id === current) return;
    current = id;
    document.documentElement.dataset.theme = id;
    if (window.playerAPI && window.playerAPI.setPref) {
      window.playerAPI.setPref('theme', id);
    }
    listeners.forEach(function (fn) { fn(id); });
  }

  function cycle() {
    var i = THEMES.findIndex(function (t) { return t.id === current; });
    set(THEMES[(i + 1) % THEMES.length].id);
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  window.MP.theme = {
    init: init,
    get: get,
    set: set,
    cycle: cycle,
    onChange: onChange,
    list: function () { return THEMES.slice(); },
  };

  // Render-blocking on purpose: runs the moment this script is parsed, before
  // <body> exists, so there is no flash of the wrong theme.
  init();
})();
