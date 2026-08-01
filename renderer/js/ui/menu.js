(function () {
  'use strict';

  var node = null;
  var openFor = null;

  function close() {
    if (!node) return;
    node.hidden = true;
    node.textContent = '';
    openFor = null;
  }

  /**
   * @param {{x: number, y: number}} at
   * @param {Array<{label: string, onClick: Function, danger?: boolean}|'-'>} items
   */
  function open(at, items, key) {
    if (!node) return;
    if (openFor && openFor === key) {
      close();
      return;
    }
    node.textContent = '';
    items.forEach(function (item) {
      if (item === '-') {
        node.appendChild(MP.util.el('div', 'menu__sep'));
        return;
      }
      var btn = MP.util.el(
        'button',
        'menu__item' + (item.danger ? ' menu__item--danger' : ''),
        item.label
      );
      btn.type = 'button';
      btn.addEventListener('click', function () {
        close();
        item.onClick();
      });
      node.appendChild(btn);
    });

    node.hidden = false;
    openFor = key;

    // Clamp into the viewport once we can measure it.
    var rect = node.getBoundingClientRect();
    var x = Math.min(at.x, window.innerWidth - rect.width - 8);
    var y = Math.min(at.y, window.innerHeight - rect.height - 8);
    node.style.left = Math.max(8, x) + 'px';
    node.style.top = Math.max(8, y) + 'px';

    var first = node.querySelector('.menu__item');
    if (first) first.focus();
  }

  function init() {
    node = document.getElementById('context-menu');
    document.addEventListener('pointerdown', function (e) {
      if (node && !node.hidden && !node.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && node && !node.hidden) {
        e.stopPropagation();
        close();
      }
    });
    window.addEventListener('blur', close);
  }

  window.MP.menu = { init: init, open: open, close: close };
})();
