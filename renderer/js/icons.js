(function () {
  'use strict';

  // Inline SVG rather than an icon font: covered by `default-src 'self'`, no
  // network, no CSP change, and the glyphs inherit currentColor.
  var P = {
    play: '<path d="M5 3.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L6.53 2.65A1 1 0 0 0 5 3.5Z"/>',
    pause: '<path d="M6 3h3.2v14H6zM10.8 3H14v14h-3.2z"/>',
    prev: '<path d="M6 4a1 1 0 0 1 2 0v4.7l7.5-4.78A1 1 0 0 1 17 4.77v10.46a1 1 0 0 1-1.53.85L8 11.3V16a1 1 0 0 1-2 0V4Z"/>',
    next: '<path d="M14 4a1 1 0 0 0-2 0v4.7L4.53 3.92A1 1 0 0 0 3 4.77v10.46a1 1 0 0 0 1.53.85L12 11.3V16a1 1 0 0 0 2 0V4Z"/>',
    shuffle:
      '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 5h2.6c1 0 1.9.5 2.5 1.3l3.8 5.4c.6.8 1.5 1.3 2.5 1.3H18M3 15h2.6c1 0 1.9-.5 2.5-1.3l.9-1.3M13 7l1.4-1.9c.6-.8 1.5-1.1 2.5-1.1h1M15.5 2.5 18 5l-2.5 2.5M15.5 10.5 18 13l-2.5 2.5"/>',
    repeat:
      '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5.5 6.5h9a2.5 2.5 0 0 1 2.5 2.5v1M14.5 13.5h-9A2.5 2.5 0 0 1 3 11v-1M7.5 4 5 6.5 7.5 9M12.5 11l2.5 2.5-2.5 2.5"/>',
    repeatOne:
      '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5.5 6.5h9a2.5 2.5 0 0 1 2.5 2.5v1M14.5 13.5h-9A2.5 2.5 0 0 1 3 11v-1M7.5 4 5 6.5 7.5 9M12.5 11l2.5 2.5-2.5 2.5"/><text x="10" y="12.4" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text>',
    volume:
      '<path d="M9.5 3.2 5.8 6.2H3.4a.9.9 0 0 0-.9.9v5.8c0 .5.4.9.9.9h2.4l3.7 3a.7.7 0 0 0 1.1-.55V3.75a.7.7 0 0 0-1.1-.55Z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M13.4 7.2a4 4 0 0 1 0 5.6M15.8 4.8a7.4 7.4 0 0 1 0 10.4"/>',
    mute:
      '<path d="M9.5 3.2 5.8 6.2H3.4a.9.9 0 0 0-.9.9v5.8c0 .5.4.9.9.9h2.4l3.7 3a.7.7 0 0 0 1.1-.55V3.75a.7.7 0 0 0-1.1-.55Z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="m13.5 7.5 4 5M17.5 7.5l-4 5"/>',
    plus: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M10 4.5v11M4.5 10h11"/>',
    more: '<circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/>',
    folder:
      '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M2.8 5.5A1.5 1.5 0 0 1 4.3 4h3l1.6 2h6.8a1.5 1.5 0 0 1 1.5 1.5v6.9a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6Z"/>',
    gear:
      '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="m16.3 12-1.1.6a5.6 5.6 0 0 1-.7 1.2l.1 1.3-1.7 1-1.1-.7c-.5.2-.9.3-1.4.4L9.8 17H7.9l-.5-1.2a5.6 5.6 0 0 1-1.3-.5l-1.2.6-1.6-1.1.2-1.3a5.6 5.6 0 0 1-.6-1.2L1.8 11.7l.1-1.9 1.3-.4c.1-.5.3-.9.5-1.3l-.6-1.2 1.2-1.5 1.3.3c.4-.3.8-.5 1.2-.7L7.2 3.7 9.1 3.5l.6 1.2c.5.1.9.2 1.3.4l1.2-.6 1.5 1.2-.3 1.3c.3.4.5.8.7 1.2l1.3.3Z"/>',
    check: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m4 10.5 4 4 8-9"/>',
    close: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m5 5 10 10M15 5 5 15"/>',
    search: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM13.5 13.5 17 17"/>',
    music:
      '<path d="M16.5 2.4a.8.8 0 0 0-.95-.78l-7.4 1.6a.8.8 0 0 0-.65.79v8.35a3 3 0 1 0 1.6 2.65V6.1l6.2-1.34v5.6a3 3 0 1 0 1.6 2.65Z"/>',
    expand:
      '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6"/>',
    trash:
      '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.7 10a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4l.7-10"/>',
    alert:
      '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M10 7v4M10 14h.01M8.6 3.1 2.2 14.4A1.6 1.6 0 0 0 3.6 16.8h12.8a1.6 1.6 0 0 0 1.4-2.4L11.4 3.1a1.6 1.6 0 0 0-2.8 0Z"/>',
  };

  /** Returns SVG markup for an icon name. Inputs are compile-time constants only. */
  function svg(name, size) {
    var body = P[name];
    if (!body) return '';
    var s = size || 20;
    return (
      '<svg viewBox="0 0 20 20" width="' + s + '" height="' + s + '" fill="currentColor" ' +
      'aria-hidden="true" focusable="false">' + body + '</svg>'
    );
  }

  /** Replaces an element's content with an icon. Safe: markup is a constant. */
  function set(node, name, size) {
    if (node) node.innerHTML = svg(name, size);
  }

  window.MP.icons = { svg: svg, set: set, names: Object.keys(P) };
})();
