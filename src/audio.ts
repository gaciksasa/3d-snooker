import * as THREE from "three";
import { PHYSICS, TABLE } from "./constants";

/**
 * Procedural sound engine for the table. Table effects are synthesised at
 * runtime with the Web Audio API; ball–ball clacks and crowd applause use
 * recorded samples.
 * Impact loudness/pitch is driven by the physics collision speed so hard shots
 * sound hard.
 *
 * Signal flow: each voice → stereo panner (from its table position relative to
 * the camera) → dry master + a send into a synthetic room reverb.
 *
 * The AudioContext can only start after a user gesture, so `resume()` must be
 * called from a click/keydown handler before any sound will play.
 */
/** Applause level relative to the original mix (0.7 × 0.7 × 0.8). */
const APPLAUSE_VOLUME = 0.392;

/** Playback speed of the applause take (< 1 = slower, longer, a touch lower). */
const APPLAUSE_RATE = 0.8;

/** Seconds of fade-out at the end of every applause. */
const APPLAUSE_FADE_OUT = 2.0;

export class AudioEngine {
  enabled = true;

  /**
   * Global pitch factor for every synthesised voice (< 1 = deeper). Scales
   * oscillator and filter frequencies; envelopes stay short, so it adds weight
   * without turning into a rumble.
   */
  pitch = 0.75;

  private ctx: AudioContext | null = null;
  /** Dry bus → limiter → speakers. */
  private master: GainNode | null = null;
  /** Reverb send bus. */
  private verbSend: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private applauseBuf: AudioBuffer | null = null;
  private ballHitBufs: AudioBuffer[] = [];

  private listenerPos = new THREE.Vector3(0, 1.6, -3);
  private listenerRight = new THREE.Vector3(1, 0, 0);

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      this.ctx = ctx;

      // Post-mix limiter → prevents clipping when many clicks stack in one frame.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      limiter.connect(ctx.destination);

      const master = ctx.createGain();
      master.gain.value = 0.6;
      // Gentle low-shelf for extra body under the clicks and thuds.
      const body = ctx.createBiquadFilter();
      body.type = "lowshelf";
      body.frequency.value = 320;
      body.gain.value = 3.5;
      master.connect(body);
      body.connect(limiter);
      this.master = master;

      const verb = ctx.createConvolver();
      verb.buffer = this.makeImpulse(ctx, 1.6);
      const verbReturn = ctx.createGain();
      verbReturn.gain.value = 0.32;
      const send = ctx.createGain();
      send.gain.value = 1;
      const verbHp = ctx.createBiquadFilter();
      verbHp.type = "highpass";
      verbHp.frequency.value = 400;
      send.connect(verbHp);
      verbHp.connect(verb);
      verb.connect(verbReturn);
      verbReturn.connect(master);
      this.verbSend = send;

      this.noise = this.makeNoise(ctx, 3);
      this.loadSamples(ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Call from a user gesture (button / click) to unlock audio. */
  resume(): void {
    this.ensure();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.ctx) void this.ctx.suspend();
    else if (on) this.resume();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** Track the camera so impacts pan and attenuate with where you stand. */
  setListener(camera: THREE.Camera): void {
    camera.getWorldPosition(this.listenerPos);
    this.listenerRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  }

  // ─── Buffers ────────────────────────────────────────────────────────────

  /** Mono white noise used by every noise-based voice. */
  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Synthetic hall response: a few early reflections + a diffuse decaying tail. */
  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Darker as it decays: average neighbouring samples more over time.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * 0.5;
      }
      for (let k = 1; k < len; k++) d[k] = d[k] * 0.6 + d[k - 1] * 0.4;
      for (const ms of [11, 19, 27, 41, 58]) {
        const idx = Math.floor((ms + ch * 3) * ctx.sampleRate / 1000);
        if (idx < len) d[idx] += (Math.random() > 0.5 ? 1 : -1) * 0.35;
      }
    }
    return buf;
  }

  // ─── Voice helpers ──────────────────────────────────────────────────────

  /**
   * Per-event output: panned + distance-attenuated, feeding dry and reverb.
   * Returns the node voices should connect to.
   */
  private out(x?: number, z?: number, verb = 0.35, life = 3): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    if (x !== undefined && z !== undefined) {
      const dx = x - this.listenerPos.x;
      const dy = TABLE.clothY - this.listenerPos.y;
      const dz = z - this.listenerPos.z;
      const dist = Math.hypot(dx, dy, dz);
      const side = (dx * this.listenerRight.x + dz * this.listenerRight.z) / Math.max(0.3, dist);
      pan.pan.value = THREE.MathUtils.clamp(side * 0.85, -0.9, 0.9);
      g.gain.value = 1 / (1 + 0.45 * Math.max(0, dist - 0.7));
    } else {
      g.gain.value = 1;
    }
    g.connect(pan);
    pan.connect(this.master!);
    const send = ctx.createGain();
    send.gain.value = verb;
    pan.connect(send);
    send.connect(this.verbSend!);
    // Let GC reclaim the chain once the voices have ended.
    setTimeout(() => {
      g.disconnect();
      pan.disconnect();
      send.disconnect();
    }, life * 1000);
    return g;
  }

  /** Exponential decay AD envelope on a gain node. */
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    const p = Math.max(0.0001, peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** Decaying oscillator partial. */
  private tone(
    dest: AudioNode,
    t: number,
    freq: number,
    freqEnd: number,
    peak: number,
    attack: number,
    decay: number,
    type: OscillatorType = "sine",
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * this.pitch, t);
    if (freqEnd !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd * this.pitch), t + attack + decay);
    }
    this.env(g, t, peak, attack, decay);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + attack + decay + 0.02);
  }

  /** Filtered noise transient (the "clack" body of an impact). */
  private burst(
    dest: AudioNode,
    t: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    attack: number,
    decay: number,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq * this.pitch;
    filt.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    src.connect(filt);
    filt.connect(g);
    g.connect(dest);
    const offset = Math.random() * 2;
    src.start(t, offset);
    src.stop(t + attack + decay + 0.05);
  }

  private norm(speed: number): number {
    return Math.min(1, Math.sqrt(Math.max(0, speed) / PHYSICS.maxShotSpeed));
  }

  // ─── Table sounds ───────────────────────────────────────────────────────

  /**
   * Two balls colliding. Uses recorded billiard-ball clacks (random variant)
   * when loaded: harder hits play louder, brighter and a touch higher; soft
   * touches are low-passed so they read as a gentle kiss. Falls back to the
   * synthesised clack until the samples have decoded.
   */
  ballClick(speed: number, x?: number, z?: number): void {
    const ctx = this.ensure();
    if (!ctx || speed < 0.1) return;
    const v = this.norm(speed);
    const t = ctx.currentTime;
    const o = this.out(x, z, 0.4);
    if (this.ballHitBufs.length) {
      const src = ctx.createBufferSource();
      src.buffer = this.ballHitBufs[Math.floor(Math.random() * this.ballHitBufs.length)];
      // Recordings are real-pitched; deepen them only gently with the global pitch.
      src.playbackRate.value = Math.sqrt(this.pitch) * (0.9 + 0.2 * v) * (0.97 + Math.random() * 0.06);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800 + 14000 * v * v;
      const g = ctx.createGain();
      g.gain.value = 0.04 + 1.1 * Math.pow(v, 1.15);
      src.connect(lp);
      lp.connect(g);
      g.connect(o);
      src.start(t);
      return;
    }
    const amp = 0.05 + 0.65 * v;
    const f0 = (2300 + 2400 * v) * (0.94 + Math.random() * 0.12);
    // Contact transient
    this.burst(o, t, "bandpass", f0 * 1.6, 2.5, amp * 0.8, 0.0003, 0.008 + 0.006 * v);
    // Ringing shell modes (inharmonic, very short)
    this.tone(o, t, f0, f0 * 0.94, amp * 0.75, 0.0004, 0.022 + 0.012 * v);
    this.tone(o, t, f0 * 2.72, f0 * 2.6, amp * 0.28, 0.0004, 0.012);
    // A little body for hard hits
    if (v > 0.2) this.tone(o, t, 820, 640, amp * 0.3, 0.001, 0.03);
  }

  /** Ball into a rubber cushion: dull thump; hard hits add a wooden rail knock. */
  cushion(speed: number, x?: number, z?: number): void {
    const ctx = this.ensure();
    if (!ctx || speed < 0.15) return;
    const v = this.norm(speed);
    const t = ctx.currentTime;
    const o = this.out(x, z, 0.3);
    const amp = 0.07 + 0.55 * v;
    this.burst(o, t, "lowpass", 320 + 380 * v, 1.0, amp * 0.9, 0.0015, 0.05 + 0.06 * v);
    this.tone(o, t, 160 + 70 * v, 110, amp * 0.8, 0.002, 0.07 + 0.03 * v, "sine");
    this.tone(o, t, 290, 190, amp * 0.3, 0.002, 0.06, "triangle");
    if (v > 0.45) {
      this.tone(o, t + 0.002, 420, 360, amp * 0.22, 0.001, 0.05, "sine");
      this.burst(o, t, "bandpass", 1800, 3, amp * 0.18, 0.0005, 0.015);
    }
  }

  /** Chalked leather tip striking the cue ball: soft "tock" + cue-wood resonance. */
  cueStrike(power01: number, x?: number, z?: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const v = Math.min(1, Math.max(0.05, power01));
    const t = ctx.currentTime;
    const o = this.out(x, z, 0.35);
    const amp = 0.12 + 0.45 * v;
    this.burst(o, t, "bandpass", 1100 + 800 * v, 2.2, amp * 0.7, 0.0006, 0.018 + 0.01 * v);
    this.tone(o, t, 600 + 280 * v, 420, amp * 0.8, 0.0008, 0.035, "sine");
    this.tone(o, t, 1700 + 500 * v, 1200, amp * 0.28, 0.0008, 0.018, "triangle");
    // Hollow wooden ring of the cue shaft
    this.tone(o, t + 0.001, 310, 290, amp * 0.18, 0.002, 0.09, "sine");
  }

  /** Ball dropping into a leather pocket: thud, drop, then a couple of settling taps. */
  pocket(speed = 2, x?: number, z?: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = this.out(x, z, 0.45);
    const v = this.norm(speed);
    // Rattle on the jaw fall
    this.burst(o, t, "bandpass", 1600 + 900 * v, 4, 0.12 + 0.2 * v, 0.0005, 0.015);
    // Leather cup thud
    this.tone(o, t + 0.03, 200, 110, 0.45 + 0.2 * v, 0.003, 0.14, "sine");
    this.tone(o, t + 0.03, 140, 90, 0.3, 0.004, 0.16, "sine");
    this.burst(o, t + 0.03, "lowpass", 700, 1, 0.22, 0.002, 0.08);
    // Knocking against balls already in the pocket
    const taps = 2 + Math.round(Math.random() * 2);
    let dt = 0.12;
    for (let i = 0; i < taps; i++) {
      dt += 0.05 + Math.random() * 0.06;
      const f = 1800 + Math.random() * 1500;
      const a = (0.1 + 0.08 * v) * (1 - i * 0.22);
      this.burst(o, t + dt, "bandpass", f, 6, a, 0.0004, 0.012);
      this.tone(o, t + dt, f * 0.9, f * 0.85, a * 0.6, 0.0004, 0.018);
    }
  }

  /**
   * Snooker-hall applause from a recorded sample (public/sounds/applause.wav,
   * CC0 — see public/sounds/CREDITS.md). `intensity` 0..1: small values play a
   * short faded excerpt, 1 plays the whole take layered twice for a bigger crowd.
   */
  applause(intensity: number): void {
    const ctx = this.ensure();
    const buf = this.applauseBuf;
    if (!ctx || !buf) return;
    const k = THREE.MathUtils.clamp(intensity, 0.05, 1);
    const t0 = ctx.currentTime + 0.1;
    // Short ripple → full take (the recording builds 0–1.2 s, fades after ~4 s).
    // Lengths are in real time, so they stretch with the slower playback.
    const offset = k < 0.6 ? 0.5 : 0;
    const wanted = (1.8 + 4.5 * k) / APPLAUSE_RATE;
    // The take is quiet (~−21 dBFS RMS), so lift it into the mix.
    const level = (1.6 + 2.2 * k) * APPLAUSE_VOLUME;
    const layers = k >= 0.6 ? 2 : 1;
    const out = this.out(undefined, undefined, 0.5, wanted + 4);
    for (let i = 0; i < layers; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // Slight detune per play/layer so repeats don't sound identical.
      const rate = APPLAUSE_RATE * (i ? 0.93 : 1) * (0.97 + Math.random() * 0.06);
      src.playbackRate.value = rate;
      // Never run past the end of the recording at this layer's speed.
      const dur = Math.min(wanted, (buf.duration - offset) / rate);
      const g = ctx.createGain();
      const start = t0 + i * 0.35;
      const peak = level * (i ? 0.6 : 1);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + (offset ? 0.25 : 0.05));
      // Fade-out at the end (starts no earlier than the fade-in ends).
      const fadeStart = Math.max(start + 0.3, start + dur - APPLAUSE_FADE_OUT);
      g.gain.setValueAtTime(peak, fadeStart);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(g);
      g.connect(out);
      src.start(start, offset);
      src.stop(start + dur + 0.05);
    }
  }

  /** Recorded samples (public/sounds, all CC0 — see CREDITS.md). */
  private loadSamples(ctx: AudioContext): void {
    const load = (name: string) =>
      fetch(`${import.meta.env.BASE_URL}sounds/${name}`)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data));
    // A missing sample just means the synthesised fallback (or no applause).
    load("applause.wav")
      .then((buf) => {
        this.applauseBuf = buf;
      })
      .catch(() => {});
    for (let i = 1; i <= 4; i++) {
      load(`ball-hit-${i}.wav`)
        .then((buf) => {
          this.ballHitBufs.push(buf);
        })
        .catch(() => {});
    }
  }
}
