(function () {
  'use strict';

  /**
   * Owns the AudioContext and every node in the chain. No DOM, no prefs, no
   * store — it takes plain state objects and applies them.
   *
   *   src(audio) ┐
   *   src(video) ┴─ inputSum ─┬─ chainIn ─ preamp ─ eq[0..11] ─┬─ analyserPost
   *                           │                                 crossfeed
   *                           │                                 width (M/S)
   *                           │                                 comp ─ makeup
   *                           │                                 ├── dry ──┐
   *                           │                                 └ revHP ─ conv ─ wet ┤
   *                           │                                 preLimit ─ analyserPeak
   *                           │                                 limiter ─ chainGain ┐
   *                           └───────────── bypassGain ─────────────────────────────┴─ outSum
   *                                                                          masterGain ─ destination
   */

  var MAX_BANDS = 12;
  var SMOOTH = 0.01; // setTargetAtTime time-constant: ~30ms settle
  var RAMP = 0.02;

  var ctx = null;
  var n = {}; // named nodes
  var bands = []; // BiquadFilterNode[]
  var srcAudio = null;
  var srcVideo = null;
  var built = false;
  var reverbConnected = false;
  var irToken = 0;

  // -- param helpers ---------------------------------------------------------

  /** Smooth for anything the user can drag. Never assign .value while running. */
  function target(param, value) {
    if (!ctx) return;
    if (ctx.state !== 'running') {
      param.value = value;
      return;
    }
    param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
  }

  /**
   * Linear ramp for anything that must land *exactly* on its target — mute has
   * to reach 0, and setTargetAtTime is asymptotic so it never quite gets there.
   */
  function ramp(param, value, seconds) {
    if (!ctx) return;
    var t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + (seconds || RAMP));
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  /**
   * Some things can't be automated (filter type, IR swap, reverb rewiring).
   * Duck the chain briefly so the coefficient jump doesn't tick.
   */
  function duck(fn) {
    if (!ctx || ctx.state !== 'running') {
      fn();
      return;
    }
    var g = n.chainGain.gain;
    var t = ctx.currentTime;
    var level = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(level, t);
    g.linearRampToValueAtTime(0, t + 0.008);
    setTimeout(function () {
      fn();
      var t2 = ctx.currentTime;
      g.cancelScheduledValues(t2);
      g.setValueAtTime(0, t2);
      g.linearRampToValueAtTime(level, t2 + 0.012);
    }, 10);
  }

  // -- construction ----------------------------------------------------------

  function ensure() {
    if (ctx) return ctx;
    // 'playback' asks for the largest buffer the platform will give us: nothing
    // here is interactive, and a bigger buffer means fewer dropouts.
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    ctx.onstatechange = function () {
      console.log('[dsp] context state:', ctx.state);
    };
    return ctx;
  }

  function gain(value) {
    var g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  function buildStereoWidth() {
    // mid = 0.5(L+R), side = 0.5(L−R); out = mid ± side*W.
    // At W=1 this reconstructs L/R exactly, which is what lets "off" be a
    // parameter value rather than a graph change.
    var input = gain(1);
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers'; // up-mixes mono to L=R, so side=0

    var split = ctx.createChannelSplitter(2);
    var merge = ctx.createChannelMerger(2);
    var midBus = gain(1);
    var sideBus = gain(1);
    var sideW = gain(1); // the only automated node here
    var sideInv = gain(-1);
    var outL = gain(1);
    var outR = gain(1);
    var lm = gain(0.5), rm = gain(0.5), ls = gain(0.5), rs = gain(-0.5);

    input.connect(split);
    split.connect(lm, 0); split.connect(rm, 1);
    split.connect(ls, 0); split.connect(rs, 1);
    lm.connect(midBus); rm.connect(midBus);
    ls.connect(sideBus); rs.connect(sideBus);
    sideBus.connect(sideW);
    sideW.connect(sideInv);
    midBus.connect(outL); sideW.connect(outL);
    midBus.connect(outR); sideInv.connect(outR);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);

    return { input: input, output: merge, width: sideW };
  }

  function buildCrossfeed() {
    // Bauer-style: a short, low-passed bleed of each channel into the other,
    // approximating what the far ear actually hears.
    var input = gain(1);
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';

    var split = ctx.createChannelSplitter(2);
    var merge = ctx.createChannelMerger(2);
    var outL = gain(1), outR = gain(1);
    var directL = gain(1), directR = gain(1);
    // Max delay is fixed at construction; 10ms is far more than the ~0.3ms used.
    var delayL = ctx.createDelay(0.01), delayR = ctx.createDelay(0.01);
    delayL.delayTime.value = 0.0003;
    delayR.delayTime.value = 0.0003;
    var lpL = ctx.createBiquadFilter(), lpR = ctx.createBiquadFilter();
    lpL.type = lpR.type = 'lowpass';
    lpL.frequency.value = lpR.frequency.value = 700;
    lpL.Q.value = lpR.Q.value = 0.5;
    var crossL = gain(0), crossR = gain(0);
    var trim = gain(1);

    input.connect(split);
    split.connect(directL, 0); directL.connect(outL);
    split.connect(directR, 1); directR.connect(outR);
    split.connect(delayL, 0); delayL.connect(lpL); lpL.connect(crossL); crossL.connect(outR);
    split.connect(delayR, 1); delayR.connect(lpR); lpR.connect(crossR); crossR.connect(outL);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);
    merge.connect(trim);

    return {
      input: input,
      output: trim,
      crossL: crossL, crossR: crossR,
      directL: directL, directR: directR,
      lpL: lpL, lpR: lpR,
      trim: trim,
      delayL: delayL, delayR: delayR,
    };
  }

  function build() {
    if (built) return;
    ensure();

    n.inputSum = gain(1);
    n.chainIn = gain(1);
    n.bypassGain = gain(0);
    n.preamp = gain(1);

    bands = [];
    for (var i = 0; i < MAX_BANDS; i++) {
      var b = ctx.createBiquadFilter();
      // A peaking filter at 0dB is exactly unity with no phase shift, so unused
      // slots are genuinely transparent rather than approximately so.
      b.type = 'peaking';
      b.frequency.value = 1000;
      b.gain.value = 0;
      b.Q.value = 1;
      bands.push(b);
    }

    n.analyserPost = ctx.createAnalyser();
    n.analyserPost.fftSize = 4096;
    n.analyserPost.smoothingTimeConstant = 0.8;
    n.analyserPost.minDecibels = -100;
    n.analyserPost.maxDecibels = -10;

    n.crossfeed = buildCrossfeed();
    n.width = buildStereoWidth();

    n.comp = ctx.createDynamicsCompressor();
    n.comp.threshold.value = 0;
    n.comp.ratio.value = 1;
    n.comp.knee.value = 0;
    n.comp.attack.value = 0.01;
    n.comp.release.value = 0.18;
    n.compMakeup = gain(1);

    n.dryGain = gain(1);
    n.wetGain = gain(0);
    n.revHP = ctx.createBiquadFilter();
    n.revHP.type = 'highpass';
    n.revHP.frequency.value = 150;
    n.convolver = ctx.createConvolver();
    n.convolver.normalize = true;

    n.preLimit = gain(1);
    n.analyserPeak = ctx.createAnalyser();
    n.analyserPeak.fftSize = 256;

    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = -1;
    n.limiter.knee.value = 0;
    n.limiter.ratio.value = 20;
    n.limiter.attack.value = 0.001;
    n.limiter.release.value = 0.05;

    n.chainGain = gain(1);
    n.outSum = gain(1);
    n.masterGain = gain(1);

    // wire the processed path
    n.inputSum.connect(n.chainIn);
    n.chainIn.connect(n.preamp);
    var tail = n.preamp;
    for (var j = 0; j < bands.length; j++) {
      tail.connect(bands[j]);
      tail = bands[j];
    }
    tail.connect(n.analyserPost); // analyses without an output path
    tail.connect(n.crossfeed.input);
    n.crossfeed.output.connect(n.width.input);
    n.width.output.connect(n.comp);
    n.comp.connect(n.compMakeup);
    n.compMakeup.connect(n.dryGain);
    n.compMakeup.connect(n.revHP); // convolver hooked up on demand
    n.wetGain.connect(n.preLimit);
    n.dryGain.connect(n.preLimit);
    n.preLimit.connect(n.analyserPeak);
    n.preLimit.connect(n.limiter);
    n.limiter.connect(n.chainGain);
    n.chainGain.connect(n.outSum);

    // the always-live escape path — three gain nodes, nothing that can fail
    n.inputSum.connect(n.bypassGain);
    n.bypassGain.connect(n.outSum);

    n.outSum.connect(n.masterGain);
    n.masterGain.connect(ctx.destination);

    built = true;
  }

  /**
   * Adopt the media elements. Irreversible: an element can only ever be bound
   * to one MediaElementAudioSourceNode, and closing the context does not
   * release it. Callers must have proved CORS first.
   */
  function attachSources(audioEl, videoEl) {
    build();
    if (!srcAudio) {
      srcAudio = ctx.createMediaElementSource(audioEl);
      srcAudio.connect(n.inputSum);
    }
    if (!srcVideo) {
      srcVideo = ctx.createMediaElementSource(videoEl);
      srcVideo.connect(n.inputSum);
    }
  }

  // -- parameter application -------------------------------------------------

  function applyBand(index, band) {
    var node = bands[index];
    if (!node) return;
    var active = band && band.on !== false;
    if (!active) {
      // Neutral, not disconnected.
      if (node.type !== 'peaking') duck(function () { node.type = 'peaking'; });
      target(node.gain, 0);
      return;
    }
    if (node.type !== band.type) {
      duck(function () { node.type = band.type; });
    }
    target(node.frequency, band.f);
    target(node.Q, band.q);
    // Shelves and bells use gain; cuts and notches ignore it.
    target(node.gain, band.type === 'highpass' || band.type === 'lowpass' || band.type === 'notch' ? 0 : band.g);
  }

  function applyEq(state) {
    var list = state.eq && state.eq.on ? state.eq.bands : [];
    for (var i = 0; i < MAX_BANDS; i++) {
      applyBand(i, list[i] || null);
    }
  }

  function applyPreamp(state) {
    target(n.preamp.gain, dbToGain(state.preamp || 0));
  }

  function applyCrossfeed(state) {
    var c = state.crossfeed;
    var amount = c.on ? c.amount : 0;
    var gx = 0.5 * amount;
    target(n.crossfeed.crossL.gain, gx);
    target(n.crossfeed.crossR.gain, gx);
    target(n.crossfeed.lpL.frequency, c.cut);
    target(n.crossfeed.lpR.frequency, c.cut);
    target(n.crossfeed.trim.gain, 1 / (1 + gx));
  }

  function applyWidth(state) {
    target(n.width.width.gain, state.width.on ? state.width.amount : 1);
  }

  function applyComp(state) {
    var c = state.comp;
    if (c.on) {
      target(n.comp.threshold, c.threshold);
      target(n.comp.ratio, c.ratio);
      target(n.comp.knee, c.knee);
      target(n.comp.attack, c.attack);
      target(n.comp.release, c.release);
      target(n.compMakeup.gain, dbToGain(c.makeup));
    } else {
      // ratio 1 with no knee is gain-transparent; the node's fixed lookahead
      // latency remains either way, so there's nothing to gain by rewiring.
      target(n.comp.threshold, 0);
      target(n.comp.ratio, 1);
      target(n.comp.knee, 0);
      target(n.compMakeup.gain, 1);
    }
  }

  function applyLimiter(state) {
    var l = state.limiter;
    target(n.limiter.threshold, l.on ? l.ceiling : 0);
    target(n.limiter.ratio, l.on ? 20 : 1);
  }

  function setReverbConnected(on) {
    if (on === reverbConnected) return;
    reverbConnected = on;
    duck(function () {
      if (on) n.revHP.connect(n.convolver);
      else {
        try { n.revHP.disconnect(n.convolver); } catch (_) {}
      }
    });
  }

  function applyReverb(state, regenerateIr) {
    var r = state.reverb;
    if (!r.on) {
      target(n.wetGain.gain, 0);
      target(n.dryGain.gain, 1);
      // Disconnect the convolver's INPUT: it convolves regardless of what its
      // output gain is, and it's by far the most expensive node here.
      setTimeout(function () {
        if (!MP.store.state.dsp.reverb.on) setReverbConnected(false);
      }, 120);
      return;
    }
    if (regenerateIr || !n.convolver.buffer) {
      var token = ++irToken;
      var make = function () {
        if (token !== irToken) return; // a newer request superseded this one
        var buffer = MP.ir.generate(ctx, r);
        if (token !== irToken) return;
        duck(function () { n.convolver.buffer = buffer; });
      };
      if (window.requestIdleCallback) window.requestIdleCallback(make, { timeout: 400 });
      else setTimeout(make, 0);
    }
    setReverbConnected(true);
    n.convolver.connect(n.wetGain);
    target(n.wetGain.gain, r.mix);
    target(n.dryGain.gain, 1 - r.mix * 0.4); // partial duck keeps the level steady
  }

  function applyAll(state, opts) {
    if (!built) return;
    applyPreamp(state);
    applyEq(state);
    applyCrossfeed(state);
    applyWidth(state);
    applyComp(state);
    applyReverb(state, opts && opts.regenerateIr);
    applyLimiter(state);
    setBypass(!state.enabled);
  }

  /** Crossfade, never a disconnect — the audio path must never be torn down. */
  function setBypass(on) {
    if (!built) return;
    ramp(n.chainGain.gain, on ? 0 : 1, 0.03);
    ramp(n.bypassGain.gain, on ? 1 : 0, 0.03);
  }

  function setOutputGain(value) {
    if (!built) return;
    ramp(n.masterGain.gain, value, RAMP);
  }

  /** Negative dB, or 0. Read-only float on the node — not an AudioParam. */
  function getReduction() {
    return built && n.comp ? n.comp.reduction : 0;
  }

  function getLimiterReduction() {
    return built && n.limiter ? n.limiter.reduction : 0;
  }

  /** Dev helper: a pure tone straight into the chain, for calibrating the analyser. */
  function testTone(hz, seconds) {
    if (!built) return;
    var osc = ctx.createOscillator();
    var g = gain(0.2);
    osc.frequency.value = hz || 1000;
    osc.connect(g);
    g.connect(n.inputSum);
    osc.start();
    osc.stop(ctx.currentTime + (seconds || 3));
  }

  window.MP.dspGraph = {
    ensure: ensure,
    build: build,
    attachSources: attachSources,
    applyAll: applyAll,
    applyBand: applyBand,
    applyEq: applyEq,
    applyPreamp: applyPreamp,
    applyCrossfeed: applyCrossfeed,
    applyWidth: applyWidth,
    applyComp: applyComp,
    applyLimiter: applyLimiter,
    applyReverb: applyReverb,
    setBypass: setBypass,
    setOutputGain: setOutputGain,
    getReduction: getReduction,
    getLimiterReduction: getLimiterReduction,
    testTone: testTone,
    bandNodes: function () { return bands; },
    nodes: function () { return n; },
    context: function () { return ctx; },
    isBuilt: function () { return built; },
  };
})();
