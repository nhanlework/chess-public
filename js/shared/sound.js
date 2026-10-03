// Chess3D/2D shared sound effects — synthesized with the Web Audio API, no
// external audio files, works fully offline. Call `unlock()` from inside a
// real user-gesture handler (e.g. the "Start Game" click) so the AudioContext
// is allowed to start on browsers that require one; playMove()/playCapture()
// are safe to call even before that (they just create the context lazily and
// no-op if the Web Audio API isn't available at all).
(function () {
  let ctx = null;

  function ensureCtx() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      ctx = new AudioContextClass();
    } catch (e) {
      return null;
    }
    return ctx;
  }

  // A short tone with a fast attack + exponential decay envelope.
  function tone({ freq, duration, type, gain, delay }) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // A short burst of decaying filtered noise, for a percussive "thud".
  function noiseBurst({ duration, gain, filterFreq, delay }) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + (delay || 0);
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, t0);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(g).connect(audioCtx.destination);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  function playMove() {
    tone({ freq: 520, duration: 0.09, type: 'triangle', gain: 0.18 });
  }

  function playCapture() {
    // Low percussive thud, then a brief harder "clack" right after — reads as
    // more forceful than a plain move without being jarring.
    noiseBurst({ duration: 0.1, gain: 0.3, filterFreq: 700 });
    tone({ freq: 220, duration: 0.16, type: 'square', gain: 0.16, delay: 0.02 });
  }

  // A noise buffer source (white, or brown when `brown`) for shaped sounds.
  function noiseSource(audioCtx, seconds, brown) {
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * seconds));
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = brown ? (last + 0.02 * white) / 1.02 : white;
      data[i] = brown ? last * 3.5 : white;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    return src;
  }

  // Tornado wind: band-passed noise whose pitch howls up and down while it
  // swells in and fades out over `duration` seconds.
  function playWind(duration) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const d = Math.max(0.5, duration || 2), t0 = audioCtx.currentTime;
    const src = noiseSource(audioCtx, d + 0.1, false);
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass'; filter.Q.value = 3;
    filter.frequency.setValueAtTime(260, t0);
    for (let i = 1; i <= 6; i++) filter.frequency.linearRampToValueAtTime(i % 2 ? 620 : 330, t0 + d * i / 6);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.22, t0 + d * 0.25);
    g.gain.setValueAtTime(0.22, t0 + d * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(filter).connect(g).connect(audioCtx.destination);
    src.start(t0);
    src.stop(t0 + d + 0.05);
  }

  // Thunder: a sharp crack followed by a low rolling rumble. `gain` scales it
  // (small strikes inside the funnel are quieter than the final bolt).
  function playThunder(gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const k = gain == null ? 1 : gain, t0 = audioCtx.currentTime;
    const crack = noiseSource(audioCtx, 0.15, false);
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1400;
    const cg = audioCtx.createGain();
    cg.gain.setValueAtTime(0.35 * k, t0);
    cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    crack.connect(hp).connect(cg).connect(audioCtx.destination);
    crack.start(t0); crack.stop(t0 + 0.16);
    const rumble = noiseSource(audioCtx, 1.3, true);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 180;
    const rg = audioCtx.createGain();
    rg.gain.setValueAtTime(0.0001, t0);
    rg.gain.linearRampToValueAtTime(0.5 * k, t0 + 0.06);
    rg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
    rumble.connect(lp).connect(rg).connect(audioCtx.destination);
    rumble.start(t0); rumble.stop(t0 + 1.3);
  }

  // Sword swoosh: a band-passed noise sweep rising then falling in pitch,
  // with a faint metallic ring on top for the king's blade.
  function playSwoosh(gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const k = gain == null ? 1 : gain, t0 = audioCtx.currentTime, d = 0.26;
    const src = noiseSource(audioCtx, d + 0.05, false);
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass'; filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(500, t0);
    filter.frequency.exponentialRampToValueAtTime(2600, t0 + d * 0.45);
    filter.frequency.exponentialRampToValueAtTime(700, t0 + d);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.28 * k, t0 + d * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(filter).connect(g).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + d + 0.05);
    tone({ freq: 1760, duration: 0.35, type: 'sine', gain: 0.03 * k, delay: 0.05 });
  }

  // Soul rising: a soft major chord swelling in and fading upward.
  function playSoul() {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.linearRampToValueAtTime(f * 1.5, t0 + 2.8);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.045, t0 + 0.5 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.9);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 3);
    });
  }

  // Queen's magic: a shimmering cluster of high partials swelling and fading.
  function playMagic(gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const k = gain == null ? 1 : gain, t0 = audioCtx.currentTime;
    [1318.5, 1567.98, 1975.53, 2637.02, 3135.96].forEach((f, i) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.linearRampToValueAtTime(f * 1.02, t0 + 1.2);
      const d = 0.06 + i * 0.07;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.linearRampToValueAtTime(0.03 * k, t0 + d + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 1.1);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0 + d); osc.stop(t0 + d + 1.15);
    });
  }

  // Falling comet: a descending whistle over a rushing noise.
  function playWhistle(duration, gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const d = Math.max(0.2, duration || 0.6), k = gain == null ? 0.3 : gain, t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator(), og = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500, t0);
    osc.frequency.exponentialRampToValueAtTime(260, t0 + d);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.linearRampToValueAtTime(0.06 * k, t0 + d * 0.5);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(og).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + d + 0.02);
    const src = noiseSource(audioCtx, d + 0.05, false);
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2400, t0);
    bp.frequency.exponentialRampToValueAtTime(500, t0 + d);
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.18 * k, t0 + d * 0.9);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.04);
    src.connect(bp).connect(ng).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + d + 0.05);
  }

  // Explosion: a deep boom with a crackle on top. `gain` scales it.
  function playBoom(gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const k = gain == null ? 1 : gain, t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator(), og = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
    og.gain.setValueAtTime(0.5 * k, t0);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    osc.connect(og).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + 0.62);
    const src = noiseSource(audioCtx, 0.9, true);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.6 * k, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
    src.connect(lp).connect(ng).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + 0.9);
  }

  // Volcanoes: a long low rumble swelling in and out over `duration` seconds.
  function playRumble(duration) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const d = Math.max(0.5, duration || 3), t0 = audioCtx.currentTime;
    const src = noiseSource(audioCtx, d + 0.1, true);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 140;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.7, t0 + d * 0.2);
    g.gain.setValueAtTime(0.7, t0 + d * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(lp).connect(g).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + d + 0.05);
  }

  // Dragon roar: a growling sawtooth sliding down through a formant filter,
  // roughened by noise.
  function playRoar() {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime, d = 1.4;
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.linearRampToValueAtTime(190, t0 + 0.25);
    osc.frequency.exponentialRampToValueAtTime(70, t0 + d);
    const lfo = audioCtx.createOscillator(), lg = audioCtx.createGain();
    lfo.frequency.value = 28; lg.gain.value = 18;
    lfo.connect(lg).connect(osc.frequency);
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(600, t0);
    bp.frequency.linearRampToValueAtTime(420, t0 + d);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.35, t0 + 0.12);
    g.gain.setValueAtTime(0.35, t0 + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(bp).connect(g).connect(audioCtx.destination);
    const src = noiseSource(audioCtx, d, false);
    const nf = audioCtx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.8;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.12, t0 + 0.1);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(nf).connect(ng).connect(audioCtx.destination);
    osc.start(t0); lfo.start(t0); src.start(t0);
    osc.stop(t0 + d + 0.05); lfo.stop(t0 + d + 0.05); src.stop(t0 + d);
  }

  // A struck piece of metal: inharmonic partials (a free plate/bar rings at
  // roughly these ratios) with fast attacks and staggered exponential decays,
  // over a short high-passed noise tick for the hit itself.
  function ring(base, partials, gain, decay, tick) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    partials.forEach((r, i) => {
      if (base * r > Math.min(16000, audioCtx.sampleRate * 0.45)) return;   // above hearing / Nyquist
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * r * (1 + (Math.random() - 0.5) * 0.012), t0);
      const d = decay * (1 - i * 0.12), a = gain / Math.pow(i + 1, 0.7);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(a, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + d + 0.02);
    });
    const src = noiseSource(audioCtx, tick.d + 0.02, false);
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = tick.f;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(tick.g, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + tick.d);
    src.connect(hp).connect(ng).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + tick.d + 0.02);
  }

  // Blade on armour: a bright clash that rings on. `pitch` shifts it.
  function playClang(gain, pitch) {
    const k = gain == null ? 1 : gain, p = pitch || 1;
    ring(560 * p, [1, 2.32, 3.87, 5.43, 7.12, 9.3], 0.1 * k, 1.1, { d: 0.07, f: 2200, g: 0.4 * k });
  }

  // A small plate dropping on stone: a short, high "clink".
  function playClink(gain, pitch) {
    const k = gain == null ? 1 : gain, p = pitch || 1;
    ring(1850 * p, [1, 2.76, 5.4, 8.93], 0.06 * k, 0.32, { d: 0.025, f: 4200, g: 0.2 * k });
  }

  // A big yawn: a low voiced "aaah" (formant-filtered sawtooth) that swells up
  // in pitch and breath, then sags and trails off in a rush of air.
  function playYawn(duration, gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const d = Math.max(0.8, duration || 2.2), k = gain == null ? 1 : gain, t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, t0);
    osc.frequency.linearRampToValueAtTime(165, t0 + d * 0.45);
    osc.frequency.exponentialRampToValueAtTime(75, t0 + d);
    const vib = audioCtx.createOscillator(), vg = audioCtx.createGain();
    vib.frequency.value = 5.5; vg.gain.value = 4;
    vib.connect(vg).connect(osc.frequency);
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(420, t0);
    bp.frequency.linearRampToValueAtTime(820, t0 + d * 0.45);   // mouth opening wide
    bp.frequency.linearRampToValueAtTime(380, t0 + d);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.1 * k, t0 + d * 0.4);
    g.gain.setValueAtTime(0.1 * k, t0 + d * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(bp).connect(g).connect(audioCtx.destination);
    const src = noiseSource(audioCtx, d + 0.05, false);
    const nf = audioCtx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 1200; nf.Q.value = 0.7;
    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.05 * k, t0 + d * 0.4);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(nf).connect(ng).connect(audioCtx.destination);
    osc.start(t0); vib.start(t0); src.start(t0);
    osc.stop(t0 + d + 0.05); vib.stop(t0 + d + 0.05); src.stop(t0 + d + 0.05);
  }

  // A long sigh: a breath of noise that falls in pitch as it runs out.
  function playSigh(duration, gain) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const d = Math.max(0.5, duration || 1.4), k = gain == null ? 1 : gain, t0 = audioCtx.currentTime;
    const src = noiseSource(audioCtx, d + 0.05, false);
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(1500, t0);
    bp.frequency.exponentialRampToValueAtTime(420, t0 + d);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.16 * k, t0 + d * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    src.connect(bp).connect(g).connect(audioCtx.destination);
    src.start(t0); src.stop(t0 + d + 0.05);
    const osc = audioCtx.createOscillator(), og = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, t0);
    osc.frequency.exponentialRampToValueAtTime(95, t0 + d);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.linearRampToValueAtTime(0.025 * k, t0 + d * 0.2);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(og).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + d + 0.05);
  }

  // A phone's notification: two quick rising pings. `kind` 'tap' is the soft
  // tick of a touch-screen swipe instead.
  function playPing(gain, kind) {
    const k = gain == null ? 1 : gain;
    if (kind === 'tap') {
      tone({ freq: 1250, duration: 0.03, type: 'sine', gain: 0.05 * k });
      return;
    }
    tone({ freq: 1318.5, duration: 0.16, type: 'sine', gain: 0.07 * k });
    tone({ freq: 1760, duration: 0.3, type: 'sine', gain: 0.07 * k, delay: 0.11 });
  }

  // Create/resume the AudioContext from inside a real user-gesture handler.
  function unlock() {
    ensureCtx();
  }

  window.ChessSound = { playMove, playCapture, playWind, playThunder, playSwoosh, playSoul,
    playMagic, playWhistle, playBoom, playRumble, playRoar, playClang, playClink, playYawn, playSigh, playPing, unlock };
})();
