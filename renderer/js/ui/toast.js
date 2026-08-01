(function () {
  'use strict';

  var container = null;
  var MAX = 3;
  var live = [];

  function dismiss(entry) {
    if (entry.dismissed) return;
    entry.dismissed = true;
    clearTimeout(entry.timer);
    entry.el.classList.add('is-leaving');
    setTimeout(function () {
      entry.el.remove();
      live = live.filter(function (e) { return e !== entry; });
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

    container.appendChild(el);
    live.push(entry);

    while (live.length > MAX) dismiss(live[0]);

    // Errors persist — the user has to acknowledge something went wrong.
    if (!isError) {
      entry.timer = setTimeout(function () { dismiss(entry); }, opts.duration || 5000);
    }

    return entry;
  }

  function init() {
    container = document.getElementById('toasts');
  }

  window.MP.toast = {
    init: init,
    show: show,
    error: function (message, opts) {
      return show(message, Object.assign({}, opts, { type: 'error' }));
    },
  };
})();
