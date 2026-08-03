(function () {
  'use strict';

  /**
   * The interactive EQ display: live spectrum, composite response curve, and
   * draggable band nodes on a log frequency axis.
   *
   * Two rules keep it cheap enough to run at 60fps:
   *   1. Nothing is allocated inside the frame loop — every typed array, Path2D
   *      and colour string is built up front or behind a dirty flag.
   *   2. The loop only runs while the panel is open, and drops its rate when
   *      nothing is playing.
   */

  var FMIN = 20;
  var FMAX = 20000;
  var LOGR = Math.log(FMAX / FMIN);
  var GDB = 18; // visible ±dB
  var PAD = 14;
  var NODE_R = 6.5;
  var HIT_R = 12;

  var canvas = null;
  var g = null;
  var grid = null; // offscreen grid layer
  var gridCtx = null;

  var W = 0, H = 0, dpr = 1;
  var raf = null;
  var running = false;
  var lastFrame = 0;

  var curveDirty = true;
  var curvePath = null;
  var curveFill = null;
  var peakDb = 0;

  // preallocated buffers, sized on resize
  var freqs = null, mag = null, phase = null, total = null;
  var specBuf = null, specY = null, peakY = null;

  var colors = {};
  var selected = 0;
  var hovered = -1;
  var dragId = null;
  var dragBand = -1;
  var reduceMotion = false;

  function D() { return MP.dspDefaults; }
  function st() { return MP.dsp.get(); }
  function bands() { return st().eq.bands; }

  // -- mapping ---------------------------------------------------------------

  function xOf(f) { return (W * Math.log(f / FMIN)) / LOGR; }
  function fOf(x) { return FMIN * Math.exp((LOGR * x) / W); }
  function yOf(db) { return H / 2 - (db / GDB) * (H / 2 - PAD); }
  function dbOf(y) { return ((H / 2 - y) * GDB) / (H / 2 - PAD); }

  // -- theme -----------------------------------------------------------------

  function readColors() {
    var cs = getComputedStyle(canvas);
    function v(name, fallback) {
      var out = cs.getPropertyValue(name).trim();
      return out || fallback;
    }
    colors = {
      grid: v('--color-border-subtle'),
      gridStrong: v('--color-border'),
      label: v('--color-text-secondary'),
      curve: v('--color-text-primary'),
      accent: v('--color-accent'),
      accentHover: v('--color-accent-hover'),
      node: v('--color-bg-surface-raised'),
      spectrum: v('--color-accent'),
      peak: v('--color-text-tertiary'),
      danger: v('--color-danger'),
      onAccent: v('--color-text-on-accent'),
    };
  }

  // -- sizing ----------------------------------------------------------------

  function resize() {
    var nextDpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return false;
    if (canvas.width === Math.round(w * nextDpr) && canvas.height === Math.round(h * nextDpr)) {
      return false;
    }
    dpr = nextDpr;
    W = w;
    H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels from here on

    var n = Math.max(2, Math.round(W));
    freqs = new Float32Array(n);
    mag = new Float32Array(n);
    phase = new Float32Array(n); // required by the API even though unused
    total = new Float32Array(n);
    specY = new Float32Array(n);
    peakY = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      freqs[i] = fOf(i);
      specY[i] = H;
      peakY[i] = H;
    }

    buildGrid();
    curveDirty = true;
    return true;
  }

  function buildGrid() {
    if (!grid) {
      grid = document.createElement('canvas');
      gridCtx = grid.getContext('2d');
    }
    grid.width = canvas.width;
    grid.height = canvas.height;
    var c = gridCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.lineWidth = 1;
    c.font = '10px ' + getComputedStyle(canvas).fontFamily;
    c.textBaseline = 'bottom';

    var verticals = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000];
    var labels = { 100: '100', 1000: '1k', 10000: '10k' };
    verticals.forEach(function (f) {
      var x = Math.round(xOf(f)) + 0.5;
      c.strokeStyle = colors.grid;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
      if (labels[f]) {
        c.fillStyle = colors.label;
        c.fillText(labels[f], x + 3, H - 3);
      }
    });

    [-12, -6, 0, 6, 12].forEach(function (db) {
      var y = Math.round(yOf(db)) + 0.5;
      c.strokeStyle = db === 0 ? colors.gridStrong : colors.grid;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
      if (db !== 0) {
        c.fillStyle = colors.label;
        c.fillText((db > 0 ? '+' : '') + db, 3, y - 2);
      }
    });
  }

  // -- curve -----------------------------------------------------------------

  /**
   * A private bank of biquads, never connected to anything, used only to
   * measure the response.
   *
   * Reading the *playing* filters instead looks equivalent and isn't: their
   * parameters are ramped, so a curve rebuilt the instant a preset or a reset
   * lands samples the filters mid-glide and caches that stale shape until the
   * next invalidation — which is why Reset all used to need a second click to
   * redraw. These are assigned directly, so the curve always shows exactly the
   * EQ the state describes. It also means the curve is correct before anything
   * has played, when there is no AudioContext at all.
   */
  var mirrorCtx = null;
  var mirrors = null;

  function mirrorBank() {
    // Prefer the real context so the response is computed at the true sample
    // rate; an OfflineAudioContext is an inert stand-in with no device and no
    // audio thread, and getFrequencyResponse needs no rendering to work.
    var want = MP.dspGraph.context() || mirrorCtx || new OfflineAudioContext(1, 1, 48000);
    if (mirrorCtx !== want || !mirrors) {
      mirrorCtx = want;
      mirrors = [];
      for (var i = 0; i < D().MAX_BANDS; i++) mirrors.push(mirrorCtx.createBiquadFilter());
    }
    return mirrors;
  }

  /**
   * Cascaded biquads multiply in the frequency domain, so the composite
   * magnitude is the product across bands. Rebuilt only when something changes.
   */
  function rebuildCurve() {
    curveDirty = false;
    var nodes = mirrorBank();
    var list = st().eq.on ? bands() : [];
    var n = total.length;
    var i, k;
    for (k = 0; k < n; k++) total[k] = 1;

    for (i = 0; i < list.length && i < nodes.length; i++) {
      var band = list[i];
      if (!band.on) continue;
      var node = nodes[i];
      node.type = band.type;
      node.frequency.value = band.f;
      node.Q.value = band.q;
      node.gain.value = D().GAINLESS_TYPES[band.type] ? 0 : band.g;
      node.getFrequencyResponse(freqs, mag, phase);
      for (k = 0; k < n; k++) total[k] *= mag[k];
    }

    var preamp = st().preamp || 0;
    curvePath = new Path2D();
    curveFill = new Path2D();
    peakDb = -Infinity;
    curveFill.moveTo(0, yOf(0));
    for (k = 0; k < n; k++) {
      var db = 20 * Math.log10(total[k] || 1e-6) + preamp;
      if (db > peakDb) peakDb = db;
      var y = yOf(db);
      if (k === 0) curvePath.moveTo(0, y);
      else curvePath.lineTo(k, y);
      curveFill.lineTo(k, y);
    }
    curveFill.lineTo(n - 1, yOf(0));
    curveFill.closePath();
    if (!isFinite(peakDb)) peakDb = 0;
  }

  // -- spectrum --------------------------------------------------------------

  function drawSpectrum() {
    if (!st().spectrum.on || !MP.dspGraph.isBuilt()) return;
    var an = MP.dspGraph.nodes().analyserPost;
    var ctx = MP.dspGraph.context();
    if (!an || !ctx) return;

    if (!specBuf || specBuf.length !== an.frequencyBinCount) {
      specBuf = new Float32Array(an.frequencyBinCount);
    }
    an.getFloatFrequencyData(specBuf);

    var binHz = ctx.sampleRate / an.fftSize;
    var last = specBuf.length - 1;
    var n = specY.length;
    var decay = reduceMotion ? 0 : 0.4;

    for (var x = 0; x < n; x++) {
      var b0 = fOf(x) / binHz;
      var b1 = fOf(x + 1) / binHz;
      var v;
      if (b1 - b0 < 1) {
        // Sub-bin column (the low end): interpolate between neighbours.
        var i0 = Math.min(last, Math.floor(b0));
        var t = b0 - i0;
        v = specBuf[i0] * (1 - t) + specBuf[Math.min(last, i0 + 1)] * t;
      } else {
        // Multi-bin column: take the max. Averaging reads as mush.
        v = -Infinity;
        var hi = Math.min(last, Math.ceil(b1));
        for (var i = Math.max(0, Math.floor(b0)); i <= hi; i++) {
          if (specBuf[i] > v) v = specBuf[i];
        }
      }
      var y = H - ((v + 100) / 90) * H;
      if (!isFinite(y)) y = H;
      specY[x] = y < 0 ? 0 : y > H ? H : y;
      peakY[x] = specY[x] < peakY[x] ? specY[x] : Math.min(H, peakY[x] + decay);
    }

    // filled body
    g.beginPath();
    g.moveTo(0, H);
    for (var k = 0; k < n; k++) g.lineTo(k, specY[k]);
    g.lineTo(n - 1, H);
    g.closePath();
    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, withAlpha(colors.spectrum, 0.45));
    grad.addColorStop(1, withAlpha(colors.spectrum, 0.02));
    g.fillStyle = grad;
    g.fill();

    if (!reduceMotion) {
      g.beginPath();
      for (var j = 0; j < n; j++) {
        if (j === 0) g.moveTo(0, peakY[0]);
        else g.lineTo(j, peakY[j]);
      }
      g.strokeStyle = withAlpha(colors.peak, 0.55);
      g.lineWidth = 1;
      g.stroke();
    }
  }

  /** Accepts hex or rgb() from the theme and applies an alpha. */
  function withAlpha(color, alpha) {
    if (!color) return 'rgba(255,255,255,' + alpha + ')';
    if (color.charAt(0) === '#') {
      var hex = color.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var num = parseInt(hex, 16);
      return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')';
    }
    if (color.indexOf('rgba') === 0) return color.replace(/[\d.]+\)$/, alpha + ')');
    if (color.indexOf('rgb') === 0) return color.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
    return color;
  }

  // -- nodes -----------------------------------------------------------------

  function nodePos(band) {
    var gainless = !!D().GAINLESS_TYPES[band.type];
    return { x: xOf(band.f), y: gainless ? yOf(0) : yOf(band.g) };
  }

  function drawNodes() {
    var list = bands();
    for (var i = 0; i < list.length; i++) {
      var band = list[i];
      var p = nodePos(band);
      var isSel = i === selected;
      var isHover = i === hovered;

      g.beginPath();
      g.arc(p.x, p.y, NODE_R + (isSel ? 2 : 0), 0, Math.PI * 2);
      g.fillStyle = band.on ? (isSel ? colors.accentHover : colors.accent) : colors.node;
      g.globalAlpha = band.on ? 1 : 0.5;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = isSel || isHover ? 2 : 1.5;
      g.strokeStyle = isSel ? colors.curve : withAlpha(colors.curve, 0.5);
      g.stroke();

      g.fillStyle = band.on ? colors.onAccent : colors.label;
      g.font = '9px ' + getComputedStyle(canvas).fontFamily;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), p.x, p.y + 0.5);
      g.textAlign = 'start';
      g.textBaseline = 'alphabetic';
    }
  }

  function hitTest(x, y) {
    var list = bands();
    var best = -1;
    var bestD = HIT_R * HIT_R;
    for (var i = list.length - 1; i >= 0; i--) {
      var p = nodePos(list[i]);
      var dx = p.x - x;
      var dy = p.y - y;
      var d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // -- frame -----------------------------------------------------------------

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    var playing = MP.store.state.playback.isPlaying;
    // Idle or backgrounded: there's nothing moving, so don't burn a frame on it.
    var minInterval = reduceMotion ? 250 : !playing ? 50 : document.hasFocus() ? 0 : 66;
    if (now - lastFrame < minInterval) return;
    lastFrame = now;

    if (resize()) readColors();
    if (!W || !H) return;
    if (curveDirty) rebuildCurve();

    g.clearRect(0, 0, W, H);
    g.drawImage(grid, 0, 0, W, H);
    // Keep reading while paused too, at the reduced rate set above: skipping it
    // would freeze the last frame's spectrum on screen instead of letting it
    // fall away to silence.
    drawSpectrum();

    // curve fill then stroke
    g.fillStyle = withAlpha(colors.curve, 0.08);
    g.fill(curveFill);
    g.strokeStyle = colors.curve;
    g.lineWidth = 1.75;
    g.lineJoin = 'round';
    g.stroke(curvePath);

    drawNodes();
  }

  function start() {
    if (running) return;
    running = true;
    readColors();
    resize();
    curveDirty = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function invalidate() {
    curveDirty = true;
  }

  function select(index) {
    selected = index;
    updateReadout();
  }

  /**
   * Always recomputes. The cached peak can lag a frame behind the filter nodes
   * while their gains are still ramping, and Auto-preamp must reflect where the
   * curve has actually landed, not where it was last painted.
   */
  function peakGainDb() {
    rebuildCurve();
    return peakDb;
  }

  // -- readout ---------------------------------------------------------------

  function updateReadout(live) {
    var node = document.querySelector('#dsp-readout .dsp__readout-text');
    if (!node) return;
    var band = bands()[selected];
    if (!band) {
      node.textContent = '';
      return;
    }
    var parts = [
      'Band ' + (selected + 1),
      D().BAND_LABELS[band.type],
      Math.round(band.f) + ' Hz',
    ];
    if (!D().GAINLESS_TYPES[band.type]) {
      parts.push((band.g >= 0 ? '+' : '') + band.g.toFixed(1) + ' dB');
    }
    parts.push('Q ' + band.q.toFixed(2));
    node.textContent = parts.join('  ·  ');
    // Silence the live region during a drag — a screen reader would otherwise
    // be read a new value 60 times a second.
    var region = document.getElementById('dsp-readout');
    if (region) region.setAttribute('aria-live', live ? 'off' : 'polite');
  }

  // -- interaction -----------------------------------------------------------

  function localPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function applyDrag(e) {
    var p = localPoint(e);
    var band = bands()[dragBand];
    if (!band) return;
    var patch = {};
    var fine = e.shiftKey ? 0.25 : 1;

    if (!e.metaKey && !e.ctrlKey) {
      var f = fOf(MP.util.clamp(p.x, 0, W));
      patch.f = fine === 1 ? f : band.f + (f - band.f) * fine;
    }
    if (!e.altKey && !D().GAINLESS_TYPES[band.type]) {
      var db = dbOf(MP.util.clamp(p.y, 0, H));
      patch.g = fine === 1 ? db : band.g + (db - band.g) * fine;
    }
    MP.dsp.setBand(dragBand, patch);
    curveDirty = true;
    updateReadout(true);
    MP.dspPanel.syncBandInputs();
  }

  function onPointerDown(e) {
    canvas.focus();
    var p = localPoint(e);
    var hit = hitTest(p.x, p.y);
    if (hit >= 0) {
      dragBand = hit;
      dragId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      select(hit);
      MP.dspPanel.setSelectedBand(hit);
      e.preventDefault();
    }
  }

  function onPointerMove(e) {
    if (dragId !== null && e.pointerId === dragId) {
      applyDrag(e);
      return;
    }
    var p = localPoint(e);
    var hit = hitTest(p.x, p.y);
    if (hit !== hovered) hovered = hit;
    canvas.style.cursor = hit >= 0 ? 'grab' : 'crosshair';
  }

  function onPointerUp(e) {
    if (dragId === null || e.pointerId !== dragId) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    dragId = null;
    dragBand = -1;
    updateReadout(false);
    MP.dsp.persist();
  }

  function onWheel(e) {
    var index = hovered >= 0 ? hovered : selected;
    var band = bands()[index];
    if (!band) return;
    e.preventDefault(); // requires passive:false, or the panel scrolls instead
    var q = MP.util.clamp(band.q * Math.exp(-e.deltaY * 0.002), 0.1, 18);
    MP.dsp.setBand(index, { q: q });
    curveDirty = true;
    select(index);
    MP.dspPanel.syncBandInputs();
  }

  function onDblClick(e) {
    var p = localPoint(e);
    var hit = hitTest(p.x, p.y);
    if (hit >= 0) {
      if (MP.dsp.removeBand(hit)) {
        selected = Math.max(0, hit - 1);
        curveDirty = true;
        MP.dspPanel.refresh();
      }
      return;
    }
    var i = MP.dsp.addBand(fOf(MP.util.clamp(p.x, 0, W)), dbOf(MP.util.clamp(p.y, 0, H)));
    if (i >= 0) {
      selected = i;
      curveDirty = true;
      MP.dspPanel.refresh();
    } else {
      MP.toast.show('Maximum of ' + D().MAX_BANDS + ' bands.');
    }
  }

  function onContextMenu(e) {
    var p = localPoint(e);
    var hit = hitTest(p.x, p.y);
    if (hit < 0) return;
    e.preventDefault();
    select(hit);
    var items = D().BAND_TYPES.map(function (type) {
      return {
        label: D().BAND_LABELS[type],
        onClick: function () {
          MP.dsp.setBand(hit, { type: type });
          curveDirty = true;
          MP.dspPanel.refresh();
        },
      };
    });
    items.push('-');
    items.push({
      label: 'Remove band',
      danger: true,
      onClick: function () {
        if (MP.dsp.removeBand(hit)) {
          selected = Math.max(0, hit - 1);
          curveDirty = true;
          MP.dspPanel.refresh();
        }
      },
    });
    MP.menu.open({ x: e.clientX, y: e.clientY }, items, 'eqband:' + hit);
  }

  /**
   * A convenience layer only — the band list below the canvas is the guaranteed
   * keyboard path. Everything here preventDefaults so arrow keys don't also
   * seek the track.
   */
  function onKeyDown(e) {
    var list = bands();
    var band = list[selected];
    if (!band) return;
    var handled = true;
    var semitone = Math.pow(2, 1 / 12);
    var step = e.shiftKey ? Math.pow(semitone, 12) : e.altKey ? Math.pow(semitone, 1 / 4) : semitone;

    switch (e.key) {
      case 'ArrowRight': MP.dsp.setBand(selected, { f: band.f * step }); break;
      case 'ArrowLeft': MP.dsp.setBand(selected, { f: band.f / step }); break;
      case 'ArrowUp': MP.dsp.setBand(selected, { g: band.g + (e.shiftKey ? 2 : 0.5) }); break;
      case 'ArrowDown': MP.dsp.setBand(selected, { g: band.g - (e.shiftKey ? 2 : 0.5) }); break;
      case '[': MP.dsp.setBand(selected, { q: band.q / 1.1 }); break;
      case ']': MP.dsp.setBand(selected, { q: band.q * 1.1 }); break;
      case 'PageUp': select((selected - 1 + list.length) % list.length); MP.dspPanel.setSelectedBand(selected); break;
      case 'PageDown': select((selected + 1) % list.length); MP.dspPanel.setSelectedBand(selected); break;
      case 'Home': select(0); MP.dspPanel.setSelectedBand(0); break;
      case 'End': select(list.length - 1); MP.dspPanel.setSelectedBand(selected); break;
      case 'Delete':
      case 'Backspace':
        if (MP.dsp.removeBand(selected)) {
          selected = Math.max(0, selected - 1);
          MP.dspPanel.refresh();
        }
        break;
      case '+':
      case '=':
        var i = MP.dsp.addBand(Math.min(FMAX, band.f * 2), 0);
        if (i >= 0) { selected = i; MP.dspPanel.refresh(); }
        break;
      case 'Enter':
        var pos = nodePos(band);
        var r = canvas.getBoundingClientRect();
        onContextMenu({
          clientX: r.left + pos.x, clientY: r.top + pos.y,
          preventDefault: function () {},
        });
        break;
      default:
        handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      curveDirty = true;
      updateReadout(false);
      MP.dspPanel.syncBandInputs();
    }
  }

  function mount() {
    canvas = document.getElementById('dsp-eq-canvas');
    if (!canvas) return;
    g = canvas.getContext('2d');

    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotion = mq.matches;
    mq.addEventListener('change', function (e) {
      reduceMotion = e.matches;
    });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', function () { hovered = -1; });
    // passive:false is required or preventDefault is ignored and the panel scrolls.
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('keydown', onKeyDown);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else if (MP.dspPanel.isOpen()) start();
    });

    // Themes swap by attribute, so re-read the palette when that happens.
    new MutationObserver(function () {
      readColors();
      buildGrid();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    MP.store.subscribe('dsp:state', function () {
      invalidate();
      // Presets, the band list and A/B all change bands without going through a
      // drag, and the readout has to follow them or it silently goes stale.
      if (dragId === null) updateReadout(false);
    });
    updateReadout(false);
  }

  window.MP.eqCanvas = {
    mount: mount,
    start: start,
    stop: stop,
    invalidate: invalidate,
    select: select,
    peakGainDb: peakGainDb,
    isRunning: function () { return running; },
  };
})();
