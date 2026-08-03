(function () {
  'use strict';

  /**
   * Controller / façade for the DSP chain. Owns the persisted state, the CORS
   * probe and the graph lifecycle. `player.js` and the UI talk to this and
   * nothing else.
   */

  var D = null; // MP.dspDefaults, resolved at init (parse-time access is banned)
  var state = null;
  var persist = null;
  var available = false;
  var probeRan = false;
  var probing = false;
  var audioEl = null;
  var videoEl = null;

  function get() {
    return state;
  }

  function isAvailable() {
    return available;
  }

  // -- CORS ------------------------------------------------------------------

  /**
   * Whether media elements should load with `crossorigin="anonymous"`.
   *
   * A runtime decision rather than a static HTML attribute: if CORS ever fails
   * on a machine the media would not load at all. Being able to revoke it means
   * the worst case is losing the effects, not losing playback.
   */
  function wantCrossOrigin() {
    return !!state && state.corsOk !== false;
  }

  function disableCrossOrigin(reason) {
    if (!state || state.corsOk === false) return;
    console.warn('[dsp] disabling cross-origin media:', reason);
    state.corsOk = false;
    available = false;
    saveNow();
    MP.store.emit('dsp:availability', { available: false, reason: reason });
  }

  /**
   * Prove the stream is CORS-clean before touching the real media elements.
   *
   * `createMediaElementSource` is irreversible — a second call throws, and
   * closing the context doesn't release the element — so an element adopted
   * against tainted media is silent forever. This uses a throwaway element and
   * never connects it to `destination`, so it is completely inaudible.
   */
  function probe(streamURL) {
    if (probeRan || probing || !streamURL) return Promise.resolve(available);
    probing = true;

    var ctx = MP.dspGraph.ensure();
    var el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.muted = false;
    el.src = streamURL;

    var src, analyser;
    try {
      src = ctx.createMediaElementSource(el);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser); // deliberately NOT connected to destination
    } catch (err) {
      probing = false;
      probeRan = true;
      return Promise.resolve(finishProbe(false, 'probe setup failed: ' + err.message));
    }

    var buf = new Float32Array(analyser.fftSize);

    function cleanup() {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
        src.disconnect();
        // The analyser holds a 512-sample buffer and stays attached to the
        // context's graph until it is disconnected — the source was released here
        // and it was not. `probeRan` means this happens at most once per session,
        // so it was a small permanent leak rather than a growing one, but the
        // element↔source binding created above can never be undone (see the note
        // on createMediaElementSource) and leaving the tail of the chain wired to
        // it kept the whole probe alive for nothing.
        analyser.disconnect();
      } catch (_) {}
    }

    return (ctx.state !== 'running' ? ctx.resume().catch(function () {}) : Promise.resolve())
      .then(function () { return el.play().catch(function () {}); })
      .then(function () {
        return new Promise(function (resolve) {
          var waited = 0;
          var timer = setInterval(function () {
            waited += 100;
            if (el.currentTime > 0.15) {
              analyser.getFloatTimeDomainData(buf);
              for (var i = 0; i < buf.length; i++) {
                if (Math.abs(buf[i]) > 1e-7) {
                  clearInterval(timer);
                  return resolve(true);
                }
              }
            }
            if (waited >= 4000) {
              clearInterval(timer);
              resolve(false);
            }
          }, 100);
        });
      })
      .then(function (ok) {
        cleanup();
        probing = false;
        probeRan = true;
        return finishProbe(ok, ok ? null : 'no signal reached the analyser');
      })
      .catch(function (err) {
        cleanup();
        probing = false;
        probeRan = true;
        return finishProbe(false, err && err.message);
      });
  }

  function finishProbe(ok, reason) {
    state.corsOk = ok;
    saveNow();
    if (!ok) {
      available = false;
      console.warn('[dsp] audio effects unavailable:', reason);
      MP.store.emit('dsp:availability', { available: false, reason: reason });
      return false;
    }
    MP.dspGraph.attachSources(audioEl, videoEl);
    available = true;
    MP.dspGraph.applyAll(state, { regenerateIr: state.reverb.on });
    // The element's own volume is now upstream of the graph; hand level control
    // to masterGain so mute and volume ramp instead of stepping.
    MP.player.refreshVolume();
    MP.store.emit('dsp:availability', { available: true });
    console.log('[dsp] audio effects active');
    return true;
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Called from play()/toggle(), which are always reached from a user gesture —
   * an AudioContext created outside one starts suspended.
   */
  function onPlay(streamURL) {
    if (!state || state.corsOk === false) return;
    var ctx = MP.dspGraph.ensure();
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    if (!probeRan) probe(streamURL);
  }

  function setElements(a, v) {
    audioEl = a;
    videoEl = v;
  }

  // -- mutation --------------------------------------------------------------

  function changed(opts) {
    if (available) MP.dspGraph.applyAll(state, opts);
    MP.store.emit('dsp:state', state);
    persist();
  }

  function setEnabled(on) {
    state.enabled = !!on;
    if (available) MP.dspGraph.setBypass(!state.enabled);
    MP.store.emit('dsp:state', state);
    saveNow();
  }

  function setPreamp(db) {
    state.preamp = D.clampRange(db, 'preamp', 0);
    if (available) MP.dspGraph.applyPreamp(state);
    MP.store.emit('dsp:state', state);
    persist();
  }

  function setBand(index, patch) {
    var band = state.eq.bands[index];
    if (!band) return;
    if (patch.type != null && D.BAND_TYPES.indexOf(patch.type) !== -1) band.type = patch.type;
    if (patch.f != null) band.f = D.clampRange(patch.f, 'band.f', band.f);
    if (patch.g != null) band.g = D.clampRange(patch.g, 'band.g', band.g);
    if (patch.q != null) band.q = D.clampRange(patch.q, 'band.q', band.q);
    if (patch.on != null) band.on = !!patch.on;
    if (available) MP.dspGraph.applyBand(index, band);
    MP.store.emit('dsp:state', state);
    persist();
  }

  function addBand(f, g) {
    if (state.eq.bands.length >= D.MAX_BANDS) return -1;
    var band = D.clampBand(
      { id: 'b' + Date.now().toString(36), on: true, type: 'peaking', f: f, g: g, q: 1 },
      state.eq.bands.length
    );
    state.eq.bands.push(band);
    state.eq.bands.sort(function (a, b) { return a.f - b.f; });
    if (available) MP.dspGraph.applyEq(state);
    MP.store.emit('dsp:state', state);
    persist();
    return state.eq.bands.indexOf(band);
  }

  function removeBand(index) {
    if (state.eq.bands.length <= 1) return false;
    state.eq.bands.splice(index, 1);
    if (available) MP.dspGraph.applyEq(state);
    MP.store.emit('dsp:state', state);
    persist();
    return true;
  }

  function setModule(name, patch) {
    var mod = state[name];
    if (!mod) return;
    var regenerateIr = false;
    Object.keys(patch).forEach(function (key) {
      if (key === 'on') {
        mod.on = !!patch[key];
        return;
      }
      var next = D.clampRange(patch[key], name + '.' + key, mod[key]);
      if (name === 'reverb' && next !== mod[key] &&
          (key === 'size' || key === 'decay' || key === 'damping' || key === 'predelay')) {
        regenerateIr = true;
      }
      mod[key] = next;
    });
    if (available) MP.dspGraph.applyAll(state, { regenerateIr: regenerateIr });
    MP.store.emit('dsp:state', state);
    // Toggling a module is a deliberate act — don't risk losing it to a crash.
    if (patch.on != null) saveNow();
    else persist();
  }

  // -- presets ---------------------------------------------------------------

  function presetNames() {
    return Object.keys(D.BUILTIN_PRESETS).concat(Object.keys(state.presets));
  }

  /**
   * Has the user edited anything since `lastPreset` was recalled or saved?
   *
   * This is the whole reason the preset list can be honest. A named preset in
   * the box after three drags of the curve is a lie, and it is the lie that
   * makes A/B confusing: the label has to describe the parameters actually
   * loaded, not the last button pressed.
   */
  function isPresetModified() {
    if (!state.lastPreset || !state.presetBasis) return false;
    // Compared against the live state rather than a snapshot of it: this runs
    // on every dsp:state emit, which includes every frame of a curve drag.
    return D.PRESET_KEYS.some(function (key) {
      return !D.deepEqual(state[key], state.presetBasis[key]);
    });
  }

  /** True when `lastPreset` still names a preset that exists. */
  function hasPresetBasis() {
    return !!state.lastPreset &&
      (isBuiltinPreset(state.lastPreset) ||
        Object.prototype.hasOwnProperty.call(state.presets, state.lastPreset));
  }

  function markPresetClean(name) {
    state.lastPreset = name;
    state.presetBasis = name ? D.presetSnapshot(state) : null;
  }

  function applyPreset(name) {
    var preset = D.BUILTIN_PRESETS[name] || state.presets[name];
    if (!preset) return false;
    var merged = D.clone(state);
    Object.keys(preset).forEach(function (key) {
      if (key === 'eq' && preset.eq && preset.eq.bands) {
        merged.eq = { on: true, bands: D.clone(preset.eq.bands) };
      } else if (typeof preset[key] === 'object' && preset[key] !== null) {
        merged[key] = Object.assign({}, merged[key], preset[key]);
      } else {
        merged[key] = preset[key];
      }
    });
    merged.lastPreset = name;
    var next = D.normalise(merged);
    next.corsOk = state.corsOk;
    next.enabled = state.enabled;
    next.presets = state.presets;
    state = next;
    // After normalise, so the basis is in the same canonical shape every later
    // snapshot will be — otherwise a freshly applied preset reads as modified.
    markPresetClean(name);
    MP.store.state.dsp = state;
    if (available) MP.dspGraph.applyAll(state, { regenerateIr: state.reverb.on });
    MP.store.emit('dsp:state', state);
    saveNow();
    return true;
  }

  function savePreset(name) {
    if (!name) return false;
    state.presets[name] = D.presetSnapshot(state);
    markPresetClean(name);
    MP.store.emit('dsp:state', state);
    saveNow();
    return true;
  }

  function deletePreset(name) {
    if (!state.presets[name]) return false;
    delete state.presets[name];
    // The parameters stay loaded — only the name they were loaded under is
    // gone, so the list should say Custom rather than point at nothing.
    if (state.lastPreset === name) markPresetClean(null);
    MP.store.emit('dsp:state', state);
    saveNow();
    return true;
  }

  function isBuiltinPreset(name) {
    return Object.prototype.hasOwnProperty.call(D.BUILTIN_PRESETS, name);
  }

  function resetAll() {
    var fresh = D.defaultDsp();
    fresh.corsOk = state.corsOk;
    fresh.presets = state.presets;
    state = fresh;
    // Defaults are exactly Flat, so say so instead of showing it as modified.
    markPresetClean('Flat');
    MP.store.state.dsp = state;
    if (available) MP.dspGraph.applyAll(state, { regenerateIr: false });
    MP.store.emit('dsp:state', state);
    saveNow();
  }

  // -- A/B -------------------------------------------------------------------

  /**
   * A and B are two independent parameter states you can flip between to
   * compare. Each slot remembers its own preset identity as well as its
   * parameters, so the preset box describes whichever slot you are hearing —
   * a slot seeded from Bass Boost and then edited reads "Bass Boost —
   * modified" no matter what the other slot was doing.
   */
  var slots = { A: null, B: null };
  var activeSlot = 'A';

  function abSlot() {
    return activeSlot;
  }

  function captureSlot() {
    return {
      params: D.presetSnapshot(state),
      lastPreset: state.lastPreset,
      presetBasis: state.presetBasis ? D.clone(state.presetBasis) : null,
    };
  }

  function abSwitch(slot) {
    if (slot === activeSlot) return;
    slots[activeSlot] = captureSlot();
    activeSlot = slot;
    var target = slots[slot];
    if (target) {
      var merged = Object.assign(D.clone(state), D.clone(target.params));
      var next = D.normalise(merged);
      next.corsOk = state.corsOk;
      next.enabled = state.enabled;
      next.presets = state.presets;
      next.lastPreset = target.lastPreset;
      next.presetBasis = target.presetBasis ? D.clone(target.presetBasis) : null;
      state = next;
      MP.store.state.dsp = state;
      if (available) MP.dspGraph.applyAll(state, { regenerateIr: state.reverb.on });
    }
    // An untouched slot starts as a copy of what you were just hearing, which
    // is what makes "switch to B, tweak, compare" the natural first move.
    MP.store.emit('dsp:state', state);
  }

  /** Copies the live settings onto the other slot. Returns that slot's name. */
  function abCopy() {
    var other = activeSlot === 'A' ? 'B' : 'A';
    slots[other] = captureSlot();
    MP.store.emit('dsp:state', state);
    return other;
  }

  /** A one-line description of a slot, for the A/B button tooltips. */
  function abDescribe(slot) {
    if (slot === activeSlot) return describe(state.lastPreset, isPresetModified());
    var held = slots[slot];
    if (!held) return 'empty — starts from the current settings';
    return describe(held.lastPreset, !D.deepEqual(held.params, held.presetBasis));
  }

  function describe(name, modified) {
    if (!name) return 'Custom';
    return name + (modified ? ' — modified' : '');
  }

  // -- persistence -----------------------------------------------------------

  function saveNow() {
    if (!state) return;
    window.playerAPI.setPref('dsp', D.snapshot(state));
  }

  function init(prefs) {
    D = MP.dspDefaults;
    state = D.normalise(prefs && prefs.dsp);
    MP.store.state.dsp = state;
    // Never persist from a pointermove; 800ms is well clear of a drag.
    persist = MP.util.debounce(saveNow, 800);
    window.addEventListener('beforeunload', saveNow);
  }

  window.MP.dsp = {
    init: init,
    get: get,
    isAvailable: isAvailable,
    setElements: setElements,
    onPlay: onPlay,
    wantCrossOrigin: wantCrossOrigin,
    disableCrossOrigin: disableCrossOrigin,
    setEnabled: setEnabled,
    setPreamp: setPreamp,
    setBand: setBand,
    addBand: addBand,
    removeBand: removeBand,
    setModule: setModule,
    changed: changed,
    presetNames: presetNames,
    applyPreset: applyPreset,
    savePreset: savePreset,
    deletePreset: deletePreset,
    isBuiltinPreset: isBuiltinPreset,
    isPresetModified: isPresetModified,
    hasPresetBasis: hasPresetBasis,
    resetAll: resetAll,
    abSlot: abSlot,
    abSwitch: abSwitch,
    abCopy: abCopy,
    abDescribe: abDescribe,
    persist: function () { if (persist) persist(); },
    persistNow: saveNow,
    graph: function () { return MP.dspGraph; },
  };
})();
