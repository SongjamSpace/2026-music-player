(function () {
  'use strict';

  /**
   * Algorithmically generated impulse responses for the reverb.
   *
   * Deliberately synthesised rather than shipped as .wav files: a convincing
   * IR set would be megabytes of binary assets, and this app has none. Noise
   * with an exponential decay envelope, progressive damping and a few sparse
   * early reflections is more than good enough as a listening effect.
   */

  /** Deterministic PRNG so the same settings always give the same room. */
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /**
   * @param {AudioContext} ctx
   * @param {{decay:number, size:number, damping:number, predelay:number}} opts
   * @returns {AudioBuffer} stereo, decorrelated channels
   */
  function generate(ctx, opts) {
    var rate = ctx.sampleRate;
    var decay = Math.max(0.2, Math.min(4, opts.decay || 2));
    var size = Math.max(0.3, Math.min(4, opts.size || 1.8));
    var damping = Math.max(0, Math.min(1, opts.damping == null ? 0.35 : opts.damping));
    var predelay = Math.max(0, Math.min(0.15, opts.predelay || 0));

    var preSamples = Math.floor(predelay * rate);
    var tailSamples = Math.max(1, Math.floor(decay * rate));
    var length = preSamples + tailSamples;
    var buffer = ctx.createBuffer(2, length, rate);

    // Bigger rooms take longer to build up and decay less abruptly.
    var decayPow = 2.2 / size;
    // Damping maps to a one-pole coefficient that gets heavier along the tail,
    // which is what makes the reverb darken as it dies away.
    var dampMax = 0.05 + damping * 0.9;

    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      // Independent noise per channel — correlated channels collapse to mono.
      var rand = rng(ch === 0 ? 0x9e3779b9 : 0x85ebca6b);
      var lp = 0;

      for (var i = 0; i < tailSamples; i++) {
        var t = i / tailSamples;
        var env = Math.pow(1 - t, decayPow);
        var white = rand() * 2 - 1;
        // Damping coefficient sweeps from light to heavy across the tail.
        var a = dampMax * t;
        lp = white * (1 - a) + lp * a;
        data[preSamples + i] = lp * env;
      }

      // A handful of sparse early reflections give the tail a sense of place.
      var reflections = [0.007, 0.011, 0.017, 0.023, 0.031, 0.041];
      for (var r = 0; r < reflections.length; r++) {
        var idx = preSamples + Math.floor(reflections[r] * size * rate);
        if (idx < length) {
          data[idx] += (rand() * 2 - 1) * 0.6 * Math.pow(1 - r / reflections.length, 2);
        }
      }
    }

    return buffer;
  }

  window.MP.ir = { generate: generate };
})();
