/**
 * 環境音（すべて WebAudio で合成。録音素材を使わないので権利確認が不要）。
 * 水音・小鳥・夏の虫・遠くの生活音（風鈴）。ユーザー操作のあとに start() する。
 */
export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timers: number[] = [];
  private volume = 0.6;
  private waterGain: GainNode | null = null;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.setTargetAtTime(this.volume, ctx.currentTime, 1.0);
    master.connect(ctx.destination);
    this.master = master;
    this.water(ctx, master);
    this.insects(ctx, master);
    this.scheduleBirds(ctx, master);
    this.scheduleChime(ctx, master);
  }

  stop(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  /** カウントダウンの音（n=3,2,1 は短く、0 はスタートの長い音） */
  beep(n: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = n > 0 ? 660 : 990;
    const g = ctx.createGain();
    const len = n > 0 ? 0.14 : 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  /** 水の勢い（流速に応じて） */
  setWaterIntensity(v: number): void {
    if (this.waterGain && this.ctx) this.waterGain.gain.setTargetAtTime(0.35 + 0.4 * v, this.ctx.currentTime, 0.5);
  }

  private noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
    const buf = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (brown) {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        } else d[i] = w;
      }
    }
    return buf;
  }

  private water(ctx: AudioContext, out: AudioNode): void {
    // 低いせせらぎ
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx, 4, true);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    this.waterGain = g;
    src.connect(lp).connect(g).connect(out);
    src.start();
    // 細かな水のきらめき（帯域ノイズを揺らす）
    const s2 = ctx.createBufferSource();
    s2.buffer = this.noiseBuffer(ctx, 3, false);
    s2.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.8;
    const g2 = ctx.createGain();
    g2.gain.value = 0.025;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 700;
    lfo.connect(lfoG).connect(bp.frequency);
    lfo.start();
    s2.connect(bp).connect(g2).connect(out);
    s2.start();
  }

  private insects(ctx: AudioContext, out: AudioNode): void {
    // 遠くの虫（高域ノイズを細かく振幅変調）
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx, 2, false);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5200;
    bp.Q.value = 6;
    const am = ctx.createGain();
    am.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.frequency.value = 38;
    const oscG = ctx.createGain();
    oscG.gain.value = 0.012;
    osc.connect(oscG).connect(am.gain);
    osc.start();
    // ゆっくり鳴いたり止んだり
    const slow = ctx.createOscillator();
    slow.frequency.value = 0.07;
    const slowG = ctx.createGain();
    slowG.gain.value = 0.006;
    slow.connect(slowG).connect(am.gain);
    slow.start();
    src.connect(bp).connect(am).connect(out);
    src.start();
  }

  private scheduleBirds(ctx: AudioContext, out: AudioNode): void {
    const chirp = () => {
      if (!this.ctx) return;
      const t0 = ctx.currentTime + 0.05;
      const n = 2 + Math.floor(Math.random() * 4);
      const base = 2600 + Math.random() * 1800;
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      pan.connect(out);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * (0.09 + Math.random() * 0.06);
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(base, t);
        o.frequency.exponentialRampToValueAtTime(base * (1.3 + Math.random() * 0.4), t + 0.05);
        o.frequency.exponentialRampToValueAtTime(base * 0.85, t + 0.08);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.035, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 0.085);
        o.connect(g).connect(pan);
        o.start(t);
        o.stop(t + 0.1);
      }
      this.timers.push(window.setTimeout(chirp, 2500 + Math.random() * 7000));
    };
    this.timers.push(window.setTimeout(chirp, 1500));
  }

  private scheduleChime(ctx: AudioContext, out: AudioNode): void {
    // 遠くの風鈴
    const ring = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime + 0.05;
      const f = 2200 + Math.random() * 300;
      for (const [mul, amp] of [[1, 0.012], [2.76, 0.005], [5.4, 0.002]]) {
        const o = ctx.createOscillator();
        o.frequency.value = f * mul;
        const g = ctx.createGain();
        g.gain.setValueAtTime(amp, t);
        g.gain.exponentialRampToValueAtTime(0.00001, t + 2.2);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 2.3);
      }
      this.timers.push(window.setTimeout(ring, 9000 + Math.random() * 16000));
    };
    this.timers.push(window.setTimeout(ring, 6000));
  }
}
