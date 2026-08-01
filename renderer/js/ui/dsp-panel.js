(function () {
  'use strict';

  var D = null;
  var panel = null;
  var btn = null;
  var body = null;
  var bandsWrap = null;
  var presetSelect = null;
  var banner = null;
  var open = false;
  var selectedBand = 0;
  var params = {}; // key → { set } so external changes can refresh the inputs
  var moduleSwitches = {};
  var grMeter = null;
  var meterTimer = null;

  function s() {
    return MP.dsp.get();
  }

  // -- small builders --------------------------------------------------------

  function el(tag, cls, text) {
    return MP.util.el(tag, cls, text);
  }

  function iconBtn(icon, label, cls) {
    var b = el('button', cls || 'icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    MP.icons.set(b, icon, 15);
    return b;
  }

  /**
   * One helper for every numeric parameter: a range and a number input kept in
   * sync. This is what makes the whole panel keyboard-operable for free — the
   * canvas is a convenience layer on top, never the only way in.
   */
  function makeParam(spec) {
    var row = el('div', 'dsp__param');
    var id = 'dsp-p-' + spec.key.replace(/[^a-z0-9]/gi, '-');

    var label = el('label', 'dsp__param-label', spec.label);
    label.htmlFor = id;

    var range = document.createElement('input');
    range.type = 'range';
    range.id = id;
    range.min = spec.min;
    range.max = spec.max;
    range.step = spec.step;

    var num = document.createElement('input');
    num.type = 'number';
    num.className = 'dsp__num';
    num.min = spec.min;
    num.max = spec.max;
    num.step = spec.step;
    num.setAttribute('aria-label', spec.label + (spec.unit ? ' in ' + spec.unit : ''));

    var display = spec.display || function (v) { return v; };
    var parse = spec.parse || function (v) { return v; };

    function push(raw, fromNum) {
      var v = MP.util.clamp(Number(raw), spec.min, spec.max);
      if (!isFinite(v)) return;
      if (!fromNum) num.value = String(v);
      range.value = String(v);
      range.setAttribute('aria-valuetext', v + (spec.unit ? ' ' + spec.unit : ''));
      spec.onChange(parse(v));
    }

    range.addEventListener('input', function () { push(range.value, false); });
    num.addEventListener('change', function () { push(num.value, true); });

    row.appendChild(label);
    row.appendChild(range);
    row.appendChild(num);

    var api = {
      row: row,
      set: function (value) {
        var v = display(value);
        range.value = String(v);
        num.value = String(v);
        range.setAttribute('aria-valuetext', v + (spec.unit ? ' ' + spec.unit : ''));
      },
      disable: function (off) {
        range.disabled = off;
        num.disabled = off;
      },
    };
    params[spec.key] = api;
    return api;
  }

  function makeSwitch(checked, onChange) {
    var sw = el('button', 'dsp__switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', checked ? 'true' : 'false');
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
    return sw;
  }

  function makeModule(name, title, note, buildBody) {
    var details = document.createElement('details');
    details.className = 'dsp__module';
    var summary = document.createElement('summary');

    var chev = el('span', 'dsp__chev');
    chev.innerHTML = MP.icons.svg('chevron', 14);
    summary.appendChild(chev);
    summary.appendChild(el('span', null, title));
    if (note) summary.appendChild(el('span', 'dsp__module-note', note));

    var sw = makeSwitch(s()[name].on, function (on) {
      MP.dsp.setModule(name, { on: on });
      syncModuleNotes();
    });
    sw.setAttribute('aria-label', title + ' enabled');
    summary.appendChild(sw);
    moduleSwitches[name] = sw;

    // Space/Enter on the switch must not also toggle the <details>.
    summary.addEventListener('keydown', function (e) {
      if (e.target === sw && (e.key === ' ' || e.key === 'Enter')) e.stopPropagation();
    });

    var inner = el('div', 'dsp__module-body');
    buildBody(inner);

    details.appendChild(summary);
    details.appendChild(inner);
    return details;
  }

  // -- band list -------------------------------------------------------------

  function renderBands() {
    bandsWrap.textContent = '';

    var head = el('div', 'dsp__band-head');
    ['', 'Type', 'Freq', 'Gain', 'Q', ''].forEach(function (t) {
      head.appendChild(el('span', null, t));
    });
    bandsWrap.appendChild(head);

    s().eq.bands.forEach(function (band, index) {
      var row = el('div', 'dsp__band');
      row.classList.toggle('is-selected', index === selectedBand);
      row.dataset.index = String(index);

      var toggle = el('button', 'dsp__band-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', band.on ? 'true' : 'false');
      toggle.setAttribute('aria-label', 'Band ' + (index + 1) + ' enabled');
      toggle.innerHTML = MP.icons.svg('check', 12);
      toggle.addEventListener('click', function () {
        MP.dsp.setBand(index, { on: !band.on });
        renderBands();
      });

      var type = document.createElement('select');
      type.setAttribute('aria-label', 'Band ' + (index + 1) + ' filter type');
      D.BAND_TYPES.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = D.BAND_LABELS[t];
        if (t === band.type) opt.selected = true;
        type.appendChild(opt);
      });
      type.addEventListener('change', function () {
        MP.dsp.setBand(index, { type: type.value });
        renderBands();
        if (MP.eqCanvas) MP.eqCanvas.invalidate();
      });

      var freq = numberCell(band.f, 20, 20000, 1, 'Band ' + (index + 1) + ' frequency in hertz', function (v) {
        MP.dsp.setBand(index, { f: v });
      });
      var gainDisabled = !!D.GAINLESS_TYPES[band.type];
      var gain = numberCell(band.g, -18, 18, 0.1, 'Band ' + (index + 1) + ' gain in decibels', function (v) {
        MP.dsp.setBand(index, { g: v });
      });
      gain.disabled = gainDisabled;
      var q = numberCell(band.q, 0.1, 18, 0.05, 'Band ' + (index + 1) + ' Q', function (v) {
        MP.dsp.setBand(index, { q: v });
      });

      var remove = iconBtn('close', 'Remove band ' + (index + 1), 'dsp__band-remove');
      remove.disabled = s().eq.bands.length <= 1;
      remove.addEventListener('click', function () {
        if (MP.dsp.removeBand(index)) {
          selectedBand = Math.max(0, index - 1);
          renderBands();
          if (MP.eqCanvas) MP.eqCanvas.invalidate();
        }
      });

      row.addEventListener('pointerdown', function () {
        selectBand(index);
      });

      row.appendChild(toggle);
      row.appendChild(type);
      row.appendChild(freq);
      row.appendChild(gain);
      row.appendChild(q);
      row.appendChild(remove);
      bandsWrap.appendChild(row);
    });

    var add = el('button', 'btn btn--ghost', 'Add band');
    add.type = 'button';
    add.disabled = s().eq.bands.length >= D.MAX_BANDS;
    add.addEventListener('click', function () {
      var i = MP.dsp.addBand(1000, 0);
      if (i >= 0) {
        selectedBand = i;
        renderBands();
        if (MP.eqCanvas) MP.eqCanvas.invalidate();
      }
    });
    bandsWrap.appendChild(add);
  }

  function numberCell(value, min, max, step, label, onChange) {
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'dsp__num';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = String(round(value, step));
    input.setAttribute('aria-label', label);
    input.addEventListener('change', function () {
      var v = MP.util.clamp(Number(input.value), min, max);
      if (!isFinite(v)) return;
      input.value = String(round(v, step));
      onChange(v);
      if (MP.eqCanvas) MP.eqCanvas.invalidate();
    });
    return input;
  }

  function round(v, step) {
    var dp = step >= 1 ? 0 : String(step).split('.')[1].length;
    return Number(v.toFixed(dp));
  }

  function selectBand(index) {
    selectedBand = index;
    Array.prototype.forEach.call(bandsWrap.querySelectorAll('.dsp__band'), function (row) {
      row.classList.toggle('is-selected', Number(row.dataset.index) === index);
    });
    if (MP.eqCanvas) MP.eqCanvas.select(index);
  }

  /** Refresh band inputs without rebuilding — used when the canvas drives changes. */
  function syncBandInputs() {
    var rows = bandsWrap.querySelectorAll('.dsp__band');
    s().eq.bands.forEach(function (band, i) {
      var row = rows[i];
      if (!row) return;
      var inputs = row.querySelectorAll('.dsp__num');
      if (document.activeElement !== inputs[0]) inputs[0].value = String(Math.round(band.f));
      if (document.activeElement !== inputs[1]) inputs[1].value = String(round(band.g, 0.1));
      if (document.activeElement !== inputs[2]) inputs[2].value = String(round(band.q, 0.05));
      var select = row.querySelector('select');
      if (select && select.value !== band.type) select.value = band.type;
      inputs[1].disabled = !!D.GAINLESS_TYPES[band.type];
      row.classList.toggle('is-selected', i === selectedBand);
    });
  }

  // -- build -----------------------------------------------------------------

  function buildHeader() {
    var head = el('div', 'dsp__head');
    head.appendChild(el('span', 'dsp__title', 'Audio'));

    presetSelect = document.createElement('select');
    presetSelect.className = 'dsp__select';
    presetSelect.setAttribute('aria-label', 'Preset');
    presetSelect.addEventListener('change', function () {
      MP.dsp.applyPreset(presetSelect.value);
      refreshAll();
    });

    var save = el('button', 'btn btn--ghost', 'Save…');
    save.type = 'button';
    save.style.height = '28px';
    save.addEventListener('click', onSavePreset);

    head.appendChild(presetSelect);
    head.appendChild(save);
    head.appendChild(el('span', 'dsp__spacer'));

    var seg = el('div', 'dsp__seg');
    ['A', 'B'].forEach(function (slot) {
      var b = el('button', null, slot);
      b.type = 'button';
      b.setAttribute('aria-label', 'Snapshot ' + slot);
      b.setAttribute('aria-pressed', MP.dsp.abSlot() === slot ? 'true' : 'false');
      b.addEventListener('click', function () {
        MP.dsp.abSwitch(slot);
        refreshAll();
      });
      seg.appendChild(b);
    });
    var copy = el('button', null, '⇄');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy current settings to the other snapshot');
    copy.title = 'Copy to other snapshot';
    copy.addEventListener('click', MP.dsp.abCopy);
    seg.appendChild(copy);
    head.appendChild(seg);

    var bypass = iconBtn('power', 'Effects on/off');
    bypass.id = 'dsp-bypass';
    bypass.addEventListener('click', function () {
      MP.dsp.setEnabled(!s().enabled);
      refreshAll();
    });
    head.appendChild(bypass);

    var close = iconBtn('close', 'Close audio effects');
    close.addEventListener('click', hide);
    head.appendChild(close);

    return head;
  }

  function onSavePreset() {
    MP.dialogs
      .prompt({
        title: 'Save preset',
        label: 'Preset name',
        value: s().lastPreset && !MP.dsp.isBuiltinPreset(s().lastPreset) ? s().lastPreset : '',
        placeholder: 'My preset',
        confirmLabel: 'Save',
      })
      .then(function (name) {
        if (!name) return;
        if (MP.dsp.isBuiltinPreset(name)) {
          MP.toast.error('“' + name + '” is a built-in preset name. Pick another.');
          return;
        }
        MP.dsp.savePreset(name);
        refreshPresets();
        MP.toast.show('Saved preset “' + name + '”.');
      });
  }

  function buildDisplay() {
    var wrap = el('div', 'dsp__display');
    var canvasWrap = el('div', 'dsp__canvas-wrap');
    var canvas = document.createElement('canvas');
    canvas.id = 'dsp-eq-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Parametric equaliser curve. Use the band list below for full keyboard control.');
    canvas.setAttribute('aria-describedby', 'dsp-readout');
    canvasWrap.appendChild(canvas);
    wrap.appendChild(canvasWrap);

    var readout = el('div', 'dsp__readout');
    readout.id = 'dsp-readout';
    readout.setAttribute('aria-live', 'polite');
    readout.appendChild(el('span', 'dsp__readout-text', ''));
    var clip = el('span', 'dsp__clip', 'LIMITING');
    clip.hidden = true;
    readout.appendChild(clip);
    wrap.appendChild(readout);
    return wrap;
  }

  function buildBody() {
    body = el('div', 'dsp__body');

    banner = el('div', 'dsp__banner');
    banner.hidden = true;
    body.appendChild(banner);

    body.appendChild(buildDisplay());

    // preamp + auto
    var preampRow = el('div', 'dsp__param');
    var preamp = makeParam({
      key: 'preamp',
      label: 'Preamp',
      min: -24,
      max: 12,
      step: 0.5,
      unit: 'dB',
      onChange: function (v) { MP.dsp.setPreamp(v); if (MP.eqCanvas) MP.eqCanvas.invalidate(); },
    });
    preampRow = preamp.row;
    var auto = el('button', 'btn btn--ghost', 'Auto');
    auto.type = 'button';
    auto.title = 'Set preamp to cancel the loudest EQ boost';
    auto.style.height = '26px';
    auto.addEventListener('click', function () {
      var peak = MP.eqCanvas ? MP.eqCanvas.peakGainDb() : 0;
      MP.dsp.setPreamp(-Math.max(0, peak));
      refreshAll();
    });
    var preampWrap = el('div');
    preampWrap.style.display = 'grid';
    preampWrap.style.gridTemplateColumns = '1fr auto';
    preampWrap.style.gap = 'var(--space-3)';
    preampWrap.style.alignItems = 'center';
    preampWrap.appendChild(preampRow);
    preampWrap.appendChild(auto);
    body.appendChild(preampWrap);

    // bands
    var bandsModule = document.createElement('details');
    bandsModule.className = 'dsp__module';
    bandsModule.open = true;
    var bandsSummary = document.createElement('summary');
    var chev = el('span', 'dsp__chev');
    chev.innerHTML = MP.icons.svg('chevron', 14);
    bandsSummary.appendChild(chev);
    bandsSummary.appendChild(el('span', null, 'Bands'));
    bandsSummary.appendChild(el('span', 'dsp__module-note', 'drag the curve, or edit here'));
    bandsModule.appendChild(bandsSummary);
    bandsWrap = el('div', 'dsp__module-body dsp__bands');
    bandsModule.appendChild(bandsWrap);
    body.appendChild(bandsModule);

    body.appendChild(buildDynamics());
    body.appendChild(buildStereo());
    body.appendChild(buildCrossfeed());
    body.appendChild(buildReverb());

    return body;
  }

  function buildDynamics() {
    return makeModule('comp', 'Dynamics', 'compressor', function (inner) {
      inner.appendChild(makeParam({
        key: 'comp.threshold', label: 'Threshold', min: -60, max: 0, step: 1, unit: 'dB',
        onChange: function (v) { MP.dsp.setModule('comp', { threshold: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'comp.ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, unit: 'to 1',
        onChange: function (v) { MP.dsp.setModule('comp', { ratio: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'comp.attack', label: 'Attack', min: 0, max: 200, step: 1, unit: 'ms',
        display: function (v) { return Math.round(v * 1000); },
        parse: function (v) { return v / 1000; },
        onChange: function (v) { MP.dsp.setModule('comp', { attack: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'comp.release', label: 'Release', min: 10, max: 1000, step: 10, unit: 'ms',
        display: function (v) { return Math.round(v * 1000); },
        parse: function (v) { return v / 1000; },
        onChange: function (v) { MP.dsp.setModule('comp', { release: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'comp.knee', label: 'Knee', min: 0, max: 40, step: 1, unit: 'dB',
        onChange: function (v) { MP.dsp.setModule('comp', { knee: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'comp.makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, unit: 'dB',
        onChange: function (v) { MP.dsp.setModule('comp', { makeup: v }); },
      }).row);

      var meterRow = el('div', 'dsp__param');
      meterRow.appendChild(el('span', 'dsp__param-label', 'Reduction'));
      grMeter = el('div', 'dsp__meter');
      grMeter.setAttribute('role', 'meter');
      grMeter.setAttribute('aria-label', 'Gain reduction in decibels');
      grMeter.setAttribute('aria-valuemin', '0');
      grMeter.setAttribute('aria-valuemax', '24');
      grMeter.setAttribute('aria-valuenow', '0');
      grMeter.appendChild(el('span', 'dsp__meter-fill'));
      meterRow.appendChild(grMeter);
      var grText = el('span', 'dsp__num');
      grText.id = 'dsp-gr-text';
      grText.textContent = '0.0';
      grText.style.pointerEvents = 'none';
      meterRow.appendChild(grText);
      inner.appendChild(meterRow);

      // limiter is a separate switch inside the same section
      var limRow = el('div', 'dsp__param');
      limRow.appendChild(el('span', 'dsp__param-label', 'Limiter'));
      var limSwitch = makeSwitch(s().limiter.on, function (on) {
        MP.dsp.setModule('limiter', { on: on });
      });
      limSwitch.setAttribute('aria-label', 'Output limiter enabled');
      moduleSwitches.limiter = limSwitch;
      limRow.appendChild(limSwitch);
      limRow.appendChild(el('span'));
      inner.appendChild(limRow);

      inner.appendChild(makeParam({
        key: 'limiter.ceiling', label: 'Ceiling', min: -6, max: 0, step: 0.5, unit: 'dB',
        onChange: function (v) { MP.dsp.setModule('limiter', { ceiling: v }); },
      }).row);
      inner.appendChild(el('p', 'dsp__hint',
        'The limiter is the safety net for EQ boosts, wide stereo and reverb — each can push the signal past full scale on its own.'));
    });
  }

  function buildStereo() {
    return makeModule('width', 'Stereo Width', null, function (inner) {
      inner.appendChild(makeParam({
        key: 'width.amount', label: 'Width', min: 0, max: 200, step: 1, unit: '%',
        display: function (v) { return Math.round(v * 100); },
        parse: function (v) { return v / 100; },
        onChange: function (v) { MP.dsp.setModule('width', { amount: v }); },
      }).row);
      var mono = el('button', 'btn btn--ghost', 'Collapse to mono');
      mono.type = 'button';
      mono.addEventListener('click', function () {
        MP.dsp.setModule('width', { on: true, amount: 0 });
        refreshAll();
      });
      inner.appendChild(mono);
      inner.appendChild(el('p', 'dsp__hint',
        '100% is the original recording. Below that narrows toward mono, above widens the sides.'));
    });
  }

  function buildCrossfeed() {
    return makeModule('crossfeed', 'Crossfeed', 'headphones', function (inner) {
      inner.appendChild(makeParam({
        key: 'crossfeed.amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%',
        display: function (v) { return Math.round(v * 100); },
        parse: function (v) { return v / 100; },
        onChange: function (v) { MP.dsp.setModule('crossfeed', { amount: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'crossfeed.cut', label: 'Cut', min: 300, max: 1200, step: 10, unit: 'Hz',
        onChange: function (v) { MP.dsp.setModule('crossfeed', { cut: v }); },
      }).row);
      inner.appendChild(el('p', 'dsp__hint',
        'Bleeds a slightly delayed, filtered copy of each channel into the other, the way your ears hear real speakers. Eases hard-panned stereo on headphones — leave it off on speakers.'));
    });
  }

  function buildReverb() {
    return makeModule('reverb', 'Reverb', 'space', function (inner) {
      inner.appendChild(makeParam({
        key: 'reverb.mix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%',
        display: function (v) { return Math.round(v * 100); },
        parse: function (v) { return v / 100; },
        onChange: function (v) { MP.dsp.setModule('reverb', { mix: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'reverb.size', label: 'Size', min: 0.3, max: 4, step: 0.1, unit: '',
        onChange: function (v) { MP.dsp.setModule('reverb', { size: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'reverb.decay', label: 'Decay', min: 0.2, max: 4, step: 0.1, unit: 's',
        onChange: function (v) { MP.dsp.setModule('reverb', { decay: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'reverb.damping', label: 'Damping', min: 0, max: 100, step: 1, unit: '%',
        display: function (v) { return Math.round(v * 100); },
        parse: function (v) { return v / 100; },
        onChange: function (v) { MP.dsp.setModule('reverb', { damping: v }); },
      }).row);
      inner.appendChild(makeParam({
        key: 'reverb.predelay', label: 'Pre-delay', min: 0, max: 150, step: 5, unit: 'ms',
        display: function (v) { return Math.round(v * 1000); },
        parse: function (v) { return v / 1000; },
        onChange: function (v) { MP.dsp.setModule('reverb', { predelay: v }); },
      }).row);
    });
  }

  function buildFooter() {
    var foot = el('div', 'dsp__foot');
    var reset = el('button', 'btn btn--ghost', 'Reset all');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      MP.dsp.resetAll();
      refreshAll();
      MP.toast.show('Audio settings reset.');
    });
    foot.appendChild(reset);
    foot.appendChild(el('span', 'dsp__spacer'));
    var del = el('button', 'btn btn--ghost', 'Delete preset');
    del.type = 'button';
    del.addEventListener('click', function () {
      var name = presetSelect.value;
      if (MP.dsp.isBuiltinPreset(name)) {
        MP.toast.error('Built-in presets can’t be deleted.');
        return;
      }
      if (MP.dsp.deletePreset(name)) {
        refreshPresets();
        MP.toast.show('Deleted preset “' + name + '”.');
      }
    });
    foot.appendChild(del);
    return foot;
  }

  // -- refresh ---------------------------------------------------------------

  function refreshPresets() {
    var current = s().lastPreset;
    presetSelect.textContent = '';
    MP.dsp.presetNames().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + (MP.dsp.isBuiltinPreset(name) ? '' : ' •');
      if (name === current) opt.selected = true;
      presetSelect.appendChild(opt);
    });
  }

  function syncModuleNotes() {
    Object.keys(moduleSwitches).forEach(function (name) {
      var on = s()[name] && s()[name].on;
      moduleSwitches[name].setAttribute('aria-checked', on ? 'true' : 'false');
    });
    updateTriggerState();
  }

  function updateTriggerState() {
    if (!btn) return;
    var st = s();
    var active =
      st.enabled &&
      (st.preamp !== 0 ||
        st.comp.on ||
        st.crossfeed.on ||
        st.reverb.on ||
        (st.width.on && st.width.amount !== 1) ||
        st.eq.bands.some(function (b) { return b.on && b.g !== 0 && !D.GAINLESS_TYPES[b.type]; }) ||
        st.eq.bands.some(function (b) { return b.on && D.GAINLESS_TYPES[b.type]; }));
    btn.classList.toggle('is-on', !!active);
  }

  function refreshAll() {
    var st = s();
    setParam('preamp', st.preamp);
    ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup'].forEach(function (k) {
      setParam('comp.' + k, st.comp[k]);
    });
    setParam('limiter.ceiling', st.limiter.ceiling);
    setParam('width.amount', st.width.amount);
    setParam('crossfeed.amount', st.crossfeed.amount);
    setParam('crossfeed.cut', st.crossfeed.cut);
    ['mix', 'size', 'decay', 'damping', 'predelay'].forEach(function (k) {
      setParam('reverb.' + k, st.reverb[k]);
    });
    renderBands();
    refreshPresets();
    syncModuleNotes();
    var bypassBtn = document.getElementById('dsp-bypass');
    if (bypassBtn) bypassBtn.setAttribute('aria-pressed', st.enabled ? 'true' : 'false');
    Array.prototype.forEach.call(panel.querySelectorAll('.dsp__seg button'), function (b) {
      if (b.textContent === 'A' || b.textContent === 'B') {
        b.setAttribute('aria-pressed', MP.dsp.abSlot() === b.textContent ? 'true' : 'false');
      }
    });
    if (MP.eqCanvas) MP.eqCanvas.invalidate();
  }

  function setParam(key, value) {
    if (params[key]) params[key].set(value);
  }

  // -- meters ----------------------------------------------------------------

  function startMeters() {
    stopMeters();
    // 4Hz, not per-frame: a screen reader would otherwise be flooded, and the
    // eye can't read faster than this anyway.
    meterTimer = setInterval(function () {
      if (!MP.dsp.isAvailable()) return;
      var gr = Math.abs(MP.dspGraph.getReduction());
      if (grMeter) {
        grMeter.querySelector('.dsp__meter-fill').style.setProperty('--fill', Math.min(1, gr / 24).toFixed(3));
        grMeter.setAttribute('aria-valuenow', gr.toFixed(1));
      }
      var text = document.getElementById('dsp-gr-text');
      if (text) text.textContent = '-' + gr.toFixed(1);
      var clip = panel.querySelector('.dsp__clip');
      if (clip) clip.hidden = Math.abs(MP.dspGraph.getLimiterReduction()) < 1;
    }, 250);
  }

  function stopMeters() {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
  }

  // -- open / close ----------------------------------------------------------

  var GAP = 10;
  var MARGIN = 8;

  function anchor() {
    var r = btn.getBoundingClientRect();
    // Measure against the top of the transport, not the button: the button sits
    // inside the bar, so clearing the button still leaves the panel overlapping
    // it. Height has to be capped before measuring, since CSS can't know where
    // the bar is.
    var transport = document.getElementById('transport');
    var ceiling = transport ? transport.getBoundingClientRect().top : r.top;
    panel.style.maxHeight = Math.max(160, ceiling - GAP - MARGIN) + 'px';

    var p = panel.getBoundingClientRect();
    var left = MP.util.clamp(r.right - p.width, MARGIN, Math.max(MARGIN, window.innerWidth - p.width - MARGIN));
    panel.style.left = left + 'px';
    panel.style.top = Math.max(MARGIN, ceiling - p.height - GAP) + 'px';
  }

  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    refreshAll();
    updateAvailability();
    anchor();
    startMeters();
    if (MP.eqCanvas) MP.eqCanvas.start();
  }

  function hide() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    stopMeters();
    if (MP.eqCanvas) MP.eqCanvas.stop();
    MP.dsp.persistNow();
    btn.focus();
  }

  function toggle() {
    if (open) hide();
    else show();
  }

  function updateAvailability() {
    var ok = MP.dsp.isAvailable();
    var probed = s().corsOk !== null;
    if (!banner) return;
    if (ok || !probed) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.textContent =
        'Audio effects are unavailable on this system — the stream could not be routed through the processor. Playback is unaffected.';
    }
  }

  /** True when focus is inside the panel, so shortcuts.js can stand down. */
  function ownsKey() {
    return open && panel.contains(document.activeElement);
  }

  function init() {
    D = MP.dspDefaults;
    panel = document.getElementById('dsp-panel');
    btn = document.getElementById('btn-dsp');
    MP.icons.set(btn, 'sliders');

    panel.appendChild(buildHeader());
    panel.appendChild(buildBody());
    panel.appendChild(buildFooter());
    MP.eqCanvas.mount(); // after the canvas exists in the DOM

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });

    // Same dismissal contract as MP.menu, minus window-blur: the user may
    // alt-tab while listening and expect the panel to still be there.
    document.addEventListener('pointerdown', function (e) {
      if (!open) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      if (e.target.closest && e.target.closest('#context-menu')) return;
      hide();
    });
    document.addEventListener('keydown', function (e) {
      if (open && e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    });
    window.addEventListener('resize', function () {
      if (open) anchor();
    });

    MP.store.subscribe('dsp:availability', function () {
      updateAvailability();
      updateTriggerState();
    });
    MP.store.subscribe('dsp:state', function () {
      updateTriggerState();
      if (open) syncBandInputs();
    });

    updateTriggerState();
  }

  window.MP.dspPanel = {
    init: init,
    open: show,
    close: hide,
    toggle: toggle,
    isOpen: function () { return open; },
    ownsKey: ownsKey,
    selectedBand: function () { return selectedBand; },
    setSelectedBand: selectBand,
    syncBandInputs: syncBandInputs,
    refresh: refreshAll,
  };
})();
