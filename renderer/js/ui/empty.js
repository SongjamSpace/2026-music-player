(function () {
  'use strict';

  /**
   * @param {HTMLElement} container
   * @param {{glyph?: string, title: string, body?: string, action?: {label: string, onClick: Function}, variant?: string}} opts
   */
  function render(container, opts) {
    container.textContent = '';
    var wrap = MP.util.el('div', 'empty' + (opts.variant ? ' empty--' + opts.variant : ''));

    if (opts.glyph) {
      var glyph = MP.util.el('div', 'empty__glyph');
      glyph.innerHTML = MP.icons.svg(opts.glyph, 44);
      wrap.appendChild(glyph);
    }

    wrap.appendChild(MP.util.el('div', 'empty__title', opts.title));
    if (opts.body) wrap.appendChild(MP.util.el('p', 'empty__body', opts.body));

    if (opts.action) {
      var btn = MP.util.el('button', 'btn btn--secondary', opts.action.label);
      btn.type = 'button';
      btn.addEventListener('click', opts.action.onClick);
      wrap.appendChild(btn);
    }

    container.appendChild(wrap);
    return wrap;
  }

  /**
   * Shimmer rows for a torrent whose metadata hasn't arrived yet. Previously
   * this state rendered nothing at all, which read as a broken app.
   */
  function skeleton(container, rows) {
    container.textContent = '';
    var wrap = MP.util.el('div', 'skeleton');
    var widths = [62, 48, 71, 55, 66, 43, 59, 50];
    for (var i = 0; i < (rows || 8); i++) {
      var row = MP.util.el('div', 'skeleton__row');
      var num = MP.util.el('div', 'skeleton__bar');
      num.style.width = '14px';
      var title = MP.util.el('div', 'skeleton__bar');
      title.style.width = widths[i % widths.length] + '%';
      var size = MP.util.el('div', 'skeleton__bar');
      size.style.opacity = '0.6';
      row.appendChild(num);
      row.appendChild(title);
      row.appendChild(size);
      wrap.appendChild(row);
    }
    var caption = MP.util.el('div', 'skeleton__caption');
    wrap.appendChild(caption);
    container.appendChild(wrap);
    return { el: wrap, caption: caption };
  }

  window.MP.empty = { render: render, skeleton: skeleton };
})();
