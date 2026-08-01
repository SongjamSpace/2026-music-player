(function () {
  'use strict';

  /**
   * Pure data and pure functions for the DSP chain. No DOM, no AudioContext,
   * no prefs — so `normalise()` can be reasoned about (and tested) in isolation.
   */

  var MAX_BANDS = 12;

  // Exact BiquadFilterNode type strings. "highpass" is presented as Low Cut and
  // "lowpass" as High Cut, which is what those filters are actually for here.
  var BAND_TYPES = ['peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch'];

  var BAND_LABELS = {
    peaking: 'Bell',
    lowshelf: 'Low Shelf',
    highshelf: 'High Shelf',
    highpass: 'Low Cut',
    lowpass: 'High Cut',
    notch: 'Notch',
  };

  /** Types whose gain parameter does nothing — the UI hides gain for these. */
  var GAINLESS_TYPES = { highpass: true, lowpass: true, notch: true };

  var RANGES = {
    preamp: [-24, 12],
    'band.f': [20, 20000],
    'band.g': [-18, 18],
    'band.q': [0.1, 18],
    'crossfeed.amount': [0, 1],
    'crossfeed.cut': [300, 1200],
    'width.amount': [0, 2],
    'comp.threshold': [-60, 0],
    'comp.ratio': [1, 20],
    'comp.attack': [0, 0.5],
    'comp.release': [0.01, 1],
    'comp.knee': [0, 40],
    'comp.makeup': [0, 24],
    'reverb.mix': [0, 1],
    'reverb.size': [0.3, 4],
    'reverb.decay': [0.2, 4],
    'reverb.damping': [0, 1],
    'reverb.predelay': [0, 0.15],
    'limiter.ceiling': [-6, 0],
  };

  function defaultBands() {
    return [
      { id: 'b1', on: true, type: 'lowshelf', f: 80, g: 0, q: 0.7 },
      { id: 'b2', on: true, type: 'peaking', f: 200, g: 0, q: 1.0 },
      { id: 'b3', on: true, type: 'peaking', f: 600, g: 0, q: 1.0 },
      { id: 'b4', on: true, type: 'peaking', f: 2000, g: 0, q: 1.0 },
      { id: 'b5', on: true, type: 'peaking', f: 6000, g: 0, q: 1.0 },
      { id: 'b6', on: true, type: 'highshelf', f: 12000, g: 0, q: 0.7 },
    ];
  }

  // Only the limiter is engaged out of the box: it makes EQ boosts safe without
  // colouring anything. Everything else is built and one click away, but the
  // app must sound exactly as it did before the user touches a control.
  function defaultDsp() {
    return {
      v: 1,
      enabled: true,
      corsOk: null, // null = not yet probed
      preamp: 0,
      eq: { on: true, bands: defaultBands() },
      crossfeed: { on: false, amount: 0.4, cut: 700 },
      width: { on: false, amount: 1.0 },
      comp: {
        on: false,
        threshold: -18,
        ratio: 3,
        attack: 0.01,
        release: 0.18,
        knee: 6,
        makeup: 0,
      },
      reverb: { on: false, mix: 0.15, size: 1.8, decay: 2.0, damping: 0.35, predelay: 0.02 },
      limiter: { on: true, ceiling: -1 },
      spectrum: { on: true },
      presets: {},
      lastPreset: 'Flat',
    };
  }

  /**
   * Built-in presets live in code, not in the saved prefs, so they can be
   * improved in a later version instead of being frozen on first launch.
   * Anything that boosts carries a matching negative preamp so it can't clip.
   */
  var BUILTIN_PRESETS = {
    Flat: { preamp: 0, eq: { bands: defaultBands() } },
    'Bass Boost': {
      preamp: -4,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'lowshelf', f: 90, g: 6.5, q: 0.7 },
          { id: 'b2', on: true, type: 'peaking', f: 180, g: 2.5, q: 0.9 },
          { id: 'b3', on: true, type: 'peaking', f: 600, g: -1.5, q: 1.0 },
          { id: 'b4', on: true, type: 'peaking', f: 2000, g: 0, q: 1.0 },
          { id: 'b5', on: true, type: 'peaking', f: 6000, g: 1, q: 1.0 },
          { id: 'b6', on: true, type: 'highshelf', f: 12000, g: 1.5, q: 0.7 },
        ],
      },
    },
    Vocal: {
      preamp: -2,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'highpass', f: 90, g: 0, q: 0.7 },
          { id: 'b2', on: true, type: 'peaking', f: 300, g: -2.5, q: 1.2 },
          { id: 'b3', on: true, type: 'peaking', f: 1200, g: 2, q: 0.9 },
          { id: 'b4', on: true, type: 'peaking', f: 3000, g: 3.5, q: 1.1 },
          { id: 'b5', on: true, type: 'peaking', f: 7000, g: 2, q: 1.2 },
          { id: 'b6', on: true, type: 'highshelf', f: 12000, g: 1, q: 0.7 },
        ],
      },
    },
    Acoustic: {
      preamp: -2,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'lowshelf', f: 100, g: 2, q: 0.7 },
          { id: 'b2', on: true, type: 'peaking', f: 250, g: -1.5, q: 1.0 },
          { id: 'b3', on: true, type: 'peaking', f: 900, g: 1, q: 1.0 },
          { id: 'b4', on: true, type: 'peaking', f: 3000, g: 2, q: 1.0 },
          { id: 'b5', on: true, type: 'peaking', f: 8000, g: 2.5, q: 1.0 },
          { id: 'b6', on: true, type: 'highshelf', f: 13000, g: 2, q: 0.7 },
        ],
      },
    },
    Electronic: {
      preamp: -4,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'lowshelf', f: 70, g: 5, q: 0.7 },
          { id: 'b2', on: true, type: 'peaking', f: 200, g: 1.5, q: 1.0 },
          { id: 'b3', on: true, type: 'peaking', f: 800, g: -2, q: 1.1 },
          { id: 'b4', on: true, type: 'peaking', f: 3000, g: 1, q: 1.0 },
          { id: 'b5', on: true, type: 'peaking', f: 9000, g: 3, q: 1.0 },
          { id: 'b6', on: true, type: 'highshelf', f: 14000, g: 3.5, q: 0.7 },
        ],
      },
      width: { on: true, amount: 1.25 },
    },
    Loudness: {
      // Equal-loudness compensation for quiet listening: lift both ends.
      preamp: -5,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'lowshelf', f: 110, g: 6, q: 0.6 },
          { id: 'b2', on: true, type: 'peaking', f: 400, g: -1.5, q: 0.9 },
          { id: 'b3', on: true, type: 'peaking', f: 1000, g: -2, q: 0.8 },
          { id: 'b4', on: true, type: 'peaking', f: 3500, g: 1, q: 1.0 },
          { id: 'b5', on: true, type: 'peaking', f: 9000, g: 3, q: 0.9 },
          { id: 'b6', on: true, type: 'highshelf', f: 13000, g: 5, q: 0.6 },
        ],
      },
    },
    Night: {
      // Squash dynamic range so quiet passages stay audible at low volume.
      preamp: -2,
      eq: {
        bands: [
          { id: 'b1', on: true, type: 'lowshelf', f: 90, g: -3, q: 0.7 },
          { id: 'b2', on: true, type: 'peaking', f: 250, g: -1, q: 1.0 },
          { id: 'b3', on: true, type: 'peaking', f: 1500, g: 1.5, q: 0.9 },
          { id: 'b4', on: true, type: 'peaking', f: 3000, g: 2, q: 1.0 },
          { id: 'b5', on: true, type: 'peaking', f: 8000, g: 0, q: 1.0 },
          { id: 'b6', on: true, type: 'highshelf', f: 12000, g: -2, q: 0.7 },
        ],
      },
      comp: { on: true, threshold: -28, ratio: 6, attack: 0.005, release: 0.25, knee: 10, makeup: 6 },
    },
  };

  // -- helpers ---------------------------------------------------------------

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function clampRange(value, key, fallback) {
    var r = RANGES[key];
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return r ? clamp(n, r[0], r[1]) : n;
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /** Returns a valid band, or null if it's too malformed to rescue. */
  function clampBand(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    var type = BAND_TYPES.indexOf(raw.type) !== -1 ? raw.type : 'peaking';
    var f = clampRange(raw.f, 'band.f', 1000);
    var g = clampRange(raw.g, 'band.g', 0);
    var q = clampRange(raw.q, 'band.q', 1);
    if (!isFinite(f) || !isFinite(g) || !isFinite(q)) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : 'b' + (index + 1) + '_' + f,
      on: raw.on !== false,
      type: type,
      f: f,
      g: g,
      q: q,
    };
  }

  /**
   * Whitelist-merge stored prefs over the defaults.
   *
   * Deliberately strict: only keys that exist in the defaults survive, every
   * number is clamped to its declared range, every enum is validated, and the
   * band array length is never trusted. That means a pref object written by a
   * newer (or corrupted) version degrades to something sane instead of poisoning
   * the audio graph with NaN — which would silence playback outright.
   */
  function normalise(raw) {
    var out = defaultDsp();
    if (!raw || typeof raw !== 'object') return out;

    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (raw.corsOk === true || raw.corsOk === false) out.corsOk = raw.corsOk;
    out.preamp = clampRange(raw.preamp, 'preamp', out.preamp);

    if (raw.eq && typeof raw.eq === 'object') {
      if (typeof raw.eq.on === 'boolean') out.eq.on = raw.eq.on;
      if (Array.isArray(raw.eq.bands)) {
        var bands = raw.eq.bands.slice(0, MAX_BANDS).map(clampBand).filter(Boolean);
        if (bands.length) out.eq.bands = bands;
      }
    }

    // Every simple module: copy known keys, clamp numerics, ignore the rest.
    [
      ['crossfeed', ['amount', 'cut']],
      ['width', ['amount']],
      ['comp', ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup']],
      ['reverb', ['mix', 'size', 'decay', 'damping', 'predelay']],
      ['limiter', ['ceiling']],
    ].forEach(function (entry) {
      var name = entry[0];
      var src = raw[name];
      if (!src || typeof src !== 'object') return;
      if (typeof src.on === 'boolean') out[name].on = src.on;
      entry[1].forEach(function (key) {
        out[name][key] = clampRange(src[key], name + '.' + key, out[name][key]);
      });
    });

    if (raw.spectrum && typeof raw.spectrum.on === 'boolean') out.spectrum.on = raw.spectrum.on;
    if (typeof raw.lastPreset === 'string') out.lastPreset = raw.lastPreset;

    if (raw.presets && typeof raw.presets === 'object' && !Array.isArray(raw.presets)) {
      Object.keys(raw.presets).slice(0, 50).forEach(function (name) {
        var p = raw.presets[name];
        if (p && typeof p === 'object') out.presets[name] = clone(p);
      });
    }

    return out;
  }

  /** A structured-cloneable plain object for IPC. Excludes nothing; small. */
  function snapshot(state) {
    return clone(state);
  }

  /** The parts of the state a preset captures — not lifecycle flags. */
  function presetSnapshot(state) {
    return clone({
      preamp: state.preamp,
      eq: state.eq,
      crossfeed: state.crossfeed,
      width: state.width,
      comp: state.comp,
      reverb: state.reverb,
      limiter: state.limiter,
    });
  }

  window.MP.dspDefaults = {
    MAX_BANDS: MAX_BANDS,
    BAND_TYPES: BAND_TYPES,
    BAND_LABELS: BAND_LABELS,
    GAINLESS_TYPES: GAINLESS_TYPES,
    RANGES: RANGES,
    BUILTIN_PRESETS: BUILTIN_PRESETS,
    defaultDsp: defaultDsp,
    defaultBands: defaultBands,
    normalise: normalise,
    clampBand: clampBand,
    clampRange: clampRange,
    snapshot: snapshot,
    presetSnapshot: presetSnapshot,
    clone: clone,
    clamp: clamp,
  };
})();
