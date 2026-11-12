import { Paint } from '../paint/types';

/** Fully procedural audio: no samples, everything synthesised with WebAudio. */
export class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;
  private sprayGain: GainNode | null = null;
  private sprayFilter: BiquadFilterNode | null = null;
  private sprayTone: OscillatorNode | null = null;
  private sprayToneGain: GainNode | null = null;
  private hum: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private restore = 0;
  private chordT = 0;
  private bellT = 2;
  private chordI = 0;
  private stepT = 0;
  volume = 0.8;
  humLevel = 0;

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 0.9; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = 0.5; this.music.connect(this.master);
    // cheap feedback-delay "reverb"
    this.wet = ctx.createGain(); this.wet.gain.value = 0.3;
    const d1 = ctx.createDelay(1), d2 = ctx.createDelay(1), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
    d1.delayTime.value = 0.23; d2.delayTime.value = 0.37; fb.gain.value = 0.45; lp.type = 'lowpass'; lp.frequency.value = 2400;
    this.wet.connect(d1); d1.connect(d2); d2.connect(lp); lp.connect(fb); fb.connect(d1); d1.connect(this.master); d2.connect(this.master);
    this.sfx.connect(this.wet); this.music.connect(this.wet);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // wind bed
    const wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 320; this.windFilter.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = 0.11;
    wind.connect(this.windFilter); this.windFilter.connect(wg); wg.connect(this.master);
    // low drone
    for (const [f, det] of [[55, 0], [55, 7], [82.4, -5]] as const) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = 0.025;
      const l = ctx.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = 180;
      o.connect(l); l.connect(g); g.connect(this.music); o.start();
    }
    // machinery hum (silent until powered)
    this.hum = ctx.createGain(); this.hum.gain.value = 0;
    const ho = ctx.createOscillator(); ho.type = 'sawtooth'; ho.frequency.value = 49;
    const ho2 = ctx.createOscillator(); ho2.type = 'square'; ho2.frequency.value = 98.6;
    const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 260;
    ho.connect(hl); ho2.connect(hl); hl.connect(this.hum); this.hum.connect(this.master); ho.start(); ho2.start();
    this.padFilter = ctx.createBiquadFilter(); this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 700; this.padFilter.connect(this.music);
  }

  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }

  private loopNoise(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.start(0, Math.random()); return s;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo = 0, delay = 0, dest?: AudioNode, attack = 0.005) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest ?? this.sfx); o.start(t); o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, type: BiquadFilterType, f0: number, f1 = 0, q = 1, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfx); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  /** Continuous spray hiss, coloured per paint. */
  spray(on: boolean, paint: Paint) {
    if (!this.ctx) return;
    if (!this.sprayGain) {
      const n = this.loopNoise();
      this.sprayFilter = this.ctx.createBiquadFilter(); this.sprayFilter.type = 'bandpass'; this.sprayFilter.Q.value = 1.4;
      this.sprayGain = this.ctx.createGain(); this.sprayGain.gain.value = 0;
      n.connect(this.sprayFilter); this.sprayFilter.connect(this.sprayGain); this.sprayGain.connect(this.sfx);
      this.sprayTone = this.ctx.createOscillator(); this.sprayTone.type = 'triangle';
      this.sprayToneGain = this.ctx.createGain(); this.sprayToneGain.gain.value = 0;
      this.sprayTone.connect(this.sprayToneGain); this.sprayToneGain.connect(this.sfx); this.sprayTone.start();
    }
    const t = this.ctx.currentTime;
    const F = [2600, 900, 4200, 1500, 2100, 1250][paint], T = [0, 110, 660, 196, 294, 82][paint];
    this.sprayFilter!.frequency.setTargetAtTime(F, t, 0.03);
    this.sprayTone!.frequency.setTargetAtTime(T || 100, t, 0.03);
    this.sprayGain.gain.setTargetAtTime(on ? 0.22 : 0, t, on ? 0.02 : 0.06);
    this.sprayToneGain!.gain.setTargetAtTime(on && T ? 0.035 : 0, t, 0.04);
  }

  shot(paint: Paint) {
    const base = [900, 240, 1200, 520, 700, 180][paint];
    this.tone(base * (0.9 + Math.random() * 0.2), 0.07, 'triangle', 0.05, base * 0.5);
  }

  splat(paint: Paint, vol = 1) {
    if (!this.ctx) return;
    const v = 0.1 * vol;
    this.noise(0.12, v, 'lowpass', 1800, 300, 0.7);
    switch (paint) {
      case Paint.Purple: this.tone(180 + Math.random() * 40, 0.25, 'sine', v * 0.7, 420); break;
      case Paint.Blue: this.tone(2400 + Math.random() * 1200, 0.09, 'sine', v * 0.5, 3200); break;
      case Paint.Green: this.tone(300 + Math.random() * 200, 0.08, 'triangle', v * 0.6, 150); break;
      case Paint.Yellow: this.tone(260, 0.14, 'sine', v * 0.7, 620); break;
      case Paint.Red: this.noise(0.06, v * 0.9, 'highpass', 3000, 0, 3); this.tone(90, 0.12, 'sawtooth', v * 0.4, 60); break;
      default: this.noise(0.2, v * 0.6, 'highpass', 5000, 9000, 0.5);
    }
  }

  pulse() { this.tone(140, 0.35, 'sine', 0.5, 38); this.noise(0.3, 0.25, 'lowpass', 900, 120); }
  jump() { this.noise(0.09, 0.07, 'bandpass', 500, 900, 1); }
  land(v: number) { const k = Math.min(1, v / 14); this.tone(90, 0.12, 'sine', 0.12 + k * 0.3, 45); this.noise(0.1, 0.06 + k * 0.14, 'lowpass', 700, 200); }
  step(ice: boolean) {
    if (ice) this.noise(0.09, 0.05, 'highpass', 5200, 3000, 2);
    else { this.noise(0.06, 0.07, 'bandpass', 380 + Math.random() * 160, 0, 1.2); this.tone(70, 0.05, 'sine', 0.06, 50); }
  }
  bounce(v: number) { const k = Math.min(1, v / 20); this.tone(160 + k * 80, 0.42, 'sine', 0.35, 520 + k * 380); this.tone(320, 0.2, 'triangle', 0.12, 900); }
  unlock() { [0, 4, 7, 12, 16].forEach((s, i) => this.tone(330 * Math.pow(2, s / 12), 0.9, 'triangle', 0.16, 0, i * 0.09)); this.noise(0.8, 0.1, 'highpass', 2000, 9000, 0.5); }
  power(on: boolean) {
    if (on) { this.tone(60, 1.1, 'sawtooth', 0.2, 240); this.tone(120, 1.1, 'square', 0.06, 480); this.noise(0.25, 0.2, 'highpass', 4000, 0, 4, 0.02); this.tone(880, 0.5, 'sine', 0.12, 0, 0.9); }
    else this.tone(220, 0.8, 'sawtooth', 0.14, 45);
  }
  door() { this.noise(1.6, 0.22, 'lowpass', 160, 90, 2); this.tone(48, 1.5, 'sawtooth', 0.12, 40); }
  grow() { for (let i = 0; i < 9; i++) this.tone(180 + i * 55 + Math.random() * 40, 0.12, 'triangle', 0.09, 260 + i * 70, i * 0.07); this.noise(0.8, 0.07, 'bandpass', 600, 2400, 2); }
  clang(vol = 1) { for (const f of [211, 337, 523, 811, 1289]) this.tone(f * (0.97 + Math.random() * 0.06), 1.4, 'sine', 0.09 * vol, 0, 0, undefined, 0.002); this.noise(0.18, 0.35 * vol, 'bandpass', 1200, 300, 1); }
  socket() { this.tone(70, 0.5, 'sine', 0.5, 35); this.clang(0.8); this.tone(440, 1.6, 'triangle', 0.14, 0, 0.25); this.tone(660, 1.6, 'triangle', 0.12, 0, 0.4); }
  checkpoint() { this.tone(523, 0.5, 'sine', 0.16); this.tone(784, 0.8, 'sine', 0.16, 0, 0.12); }
  respawn() { this.tone(500, 0.5, 'sine', 0.2, 90); this.noise(0.5, 0.12, 'bandpass', 2000, 200, 1.5); }
  deny() { this.tone(150, 0.14, 'square', 0.1); this.tone(110, 0.2, 'square', 0.1, 0, 0.12); }
  select(paint: Paint) { const f = [500, 392, 440, 523, 587, 349][paint]; this.tone(f, 0.12, 'triangle', 0.12); this.tone(f * 1.5, 0.16, 'sine', 0.08, 0, 0.05); }
  sting() { [0, 7, 12, 19].forEach((s, i) => this.tone(110 * Math.pow(2, s / 12), 3.2, 'triangle', 0.13, 0, i * 0.18, this.music, 0.6)); }
  finale() {
    [0, 4, 7, 11, 14, 19, 24].forEach((s, i) => this.tone(130.8 * Math.pow(2, s / 12), 7, 'triangle', 0.16, 0, i * 0.3, this.music, 1.2));
    this.tone(40, 4, 'sine', 0.6, 160); this.noise(4, 0.3, 'bandpass', 200, 6000, 0.6);
  }

  setRestore(r: number) { this.restore = r; }

  footsteps(dt: number, speed: number, grounded: boolean, ice: boolean) {
    if (!grounded || speed < 1.5) { this.stepT = Math.min(this.stepT, 0.15); return; }
    this.stepT -= dt * (speed / 6);
    if (this.stepT <= 0) { this.stepT = 0.42; this.step(ice); }
  }

  update(dt: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.hum!.gain.setTargetAtTime(this.humLevel * 0.05, t, 0.5);
    this.windFilter!.frequency.setTargetAtTime(260 + Math.sin(t * 0.13) * 90 + Math.sin(t * 0.31) * 40, t, 0.5);
    this.padFilter!.frequency.setTargetAtTime(500 + this.restore * 2600, t, 1);
    // slow generative pad that blooms as the world is restored
    this.chordT -= dt;
    if (this.chordT <= 0) {
      this.chordT = 9;
      const chords = [[0, 7, 12, 15, 22], [-4, 3, 8, 12, 19], [-7, 5, 9, 12, 16], [-2, 5, 10, 14, 17]];
      const ch = chords[this.chordI++ % chords.length];
      const vol = 0.022 + this.restore * 0.03;
      for (const s of ch) {
        const o = this.ctx.createOscillator(); o.type = s > 10 ? 'sine' : 'triangle';
        o.frequency.value = 110 * Math.pow(2, s / 12); o.detune.value = (Math.random() - 0.5) * 14;
        const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 3.5); g.gain.linearRampToValueAtTime(0.0001, t + 11);
        o.connect(g); g.connect(this.padFilter!); o.start(t); o.stop(t + 11.2);
      }
    }
    this.bellT -= dt;
    if (this.bellT <= 0) {
      this.bellT = 1.2 + Math.random() * (5 - this.restore * 3.2);
      if (Math.random() < 0.25 + this.restore * 0.7) {
        const scale = [0, 3, 5, 7, 10, 12, 15, 17];
        const s = scale[Math.floor(Math.random() * scale.length)];
        this.tone(440 * Math.pow(2, s / 12), 2.4, 'sine', 0.03 + this.restore * 0.04, 0, 0, this.music, 0.01);
      }
    }
  }
}
