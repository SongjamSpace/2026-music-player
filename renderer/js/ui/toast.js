(function () {
  'use strict';

  var container = null;
  var MAX = 3;
  var live = [];

  // -- top layer -------------------------------------------------------------

  /**
   * Keep the stack in the browser's top layer.
   *
   * Being *in* the top layer isn't enough on its own: order there is order of
   * entry, not z-index, so a dialog opened after us would sit on top — the
   * original bug wearing a different hat. Re-promoting on every toast makes us
   * the most recent entrant, which is the only way to be sure.
   *
   * A toast raised over an open modal is readable but not clickable:
   * showModal() marks everything outside the dialog inert. The auto-dismiss
   * timer is unaffected, and the buttons come back when the dialog closes.
   */
  function promote() {
    if (!container || !container.showPopover) return;
    try {
      if (container.matches(':popover-open')) container.hidePopover();
      container.showPopover();
    } catch (_) {
      // Falls back to --z-toast-fallback, which still clears the DSP panel.
    }
  }

  // -- keeping out of the way ------------------------------------------------

  /**
   * Regions the stack should avoid, keyed by owner. Panels call this rather
   * than toast.js knowing what a panel is, so anything added later gets the
   * same behaviour for free.
   *
   * @param {string} key
   * @param {DOMRect|null} rect  null to release
   */
  var reserved = {};
  var GAP = 12;
  var MIN_WIDTH = 280; // below this a toast is too cramped to be worth dodging

  function reserve(key, rect) {
    if (rect) reserved[key] = { left: rect.left, right: rect.right };
    else delete reserved[key];
    reposition();
  }

  function reposition() {
    if (!container) return;
    var base = 0; // resolved from --space-6 by the CSS default
    var want = base;
    Object.keys(reserved).forEach(function (key) {
      var clearance = window.innerWidth - reserved[key].left + GAP;
      if (clearance > want) want = clearance;
    });

    // No room to dodge — stay put and overlap. The top layer already
    // guarantees the toast is readable; a 120px-wide one would not be.
    var style = container.style;
    if (want <= base || window.innerWidth - want < MIN_WIDTH) {
      style.removeProperty('--toasts-right');
      return;
    }
    style.setProperty('--toasts-right', want + 'px');
  }

  function dismiss(entry) {
    if (entry.dismissed) return;
    entry.dismissed = true;
    clearTimeout(entry.timer);
    // Leave the queue synchronously. The element sticks around for the exit
    // animation, but `live` must shrink before this returns — the overflow trim
    // in show() loops on live.length, and an entry that is already dismissed
    // early-returns above, so deferring this spins the main thread forever.
    live = live.filter(function (e) { return e !== entry; });
    entry.el.classList.add('is-leaving');
    setTimeout(function () {
      entry.el.remove();
    }, 200);
  }

  /**
   * @param {string} message
   * @param {{type?: 'info'|'error', action?: {label: string, onClick: Function}, duration?: number}} [opts]
   */
  function show(message, opts) {
    if (!container) return;
    opts = opts || {};
    var isError = opts.type === 'error';

    var el = MP.util.el('div', 'toast' + (isError ? ' toast--error' : ''));
    // Errors interrupt; everything else waits its turn in the SR queue.
    el.setAttribute('role', isError ? 'alert' : 'status');

    var body = MP.util.el('div', 'toast__body', message);
    el.appendChild(body);

    var entry = { el: el, dismissed: false, timer: null };

    if (opts.action) {
      var action = MP.util.el('button', 'toast__action', opts.action.label);
      action.type = 'button';
      action.addEventListener('click', function () {
        opts.action.onClick();
        dismiss(entry);
      });
      el.appendChild(action);
    }

    var close = MP.util.el('button', 'toast__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss notification');
    MP.icons.set(close, 'close');
    close.addEventListener('click', function () { dismiss(entry); });
    el.appendChild(close);

    promote();
    container.appendChild(el);
    live.push(entry);

    // Bounded regardless: freezing the whole UI is far worse than leaving one
    // extra toast on screen if this ever stops shrinking again.
    var guard = 0;
    while (live.length > MAX && guard++ < MAX + 5) dismiss(live[0]);

    // Errors persist — the user has to acknowledge something went wrong.
    if (!isError) {
      entry.timer = setTimeout(function () { dismiss(entry); }, opts.duration || 5000);
    }

    return entry;
  }

  function init() {
    container = document.getElementById('toasts');
    promote();
    window.addEventListener('resize', reposition);
  }

  window.MP.toast = {
    init: init,
    show: show,
    reserve: reserve,
    error: function (message, opts) {
      return show(message, Object.assign({}, opts, { type: 'error' }));
    },
  };
})();
