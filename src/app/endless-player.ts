/**
 * どこまでもモードの再生。区間をまたぐと 3D のコースを次の区間に切り替える。
 * 滝壺の逆流につかまっている間は、葉を縦にくるくる回して見せる（見た目だけ）。
 */
import { ENDLESS, SIM, type EndlessCourse, type EndlessTrace, type LeafPose } from '../../packages/sim-core/src/index.ts';
import type { CanalScene } from '../render/scene.ts';

export type EndlessPhase = 'countdown' | 'running' | 'stopped' | 'done';

export interface EndlessTick {
  phase: EndlessPhase;
  t: number;
  chunk: number;
  /** ここまでに進んだ距離（cm） */
  distance: number;
  pose: LeafPose;
}

const COUNTDOWN = 3;
const TWO_PI = Math.PI * 2;

export class EndlessPlayer {
  phase: EndlessPhase = 'countdown';
  t = 0;
  speed = 1;
  onTick: ((s: EndlessTick) => void) | null = null;
  onPhase: ((p: EndlessPhase) => void) | null = null;
  onCount: ((n: number) => void) | null = null;
  /** 区間が切り替わった（i は新しい区間） */
  onChunk: ((i: number) => void) | null = null;

  private phaseTime = 0;
  private lastCount = -1;
  private shownChunk = -1;
  private pose: LeafPose = { x: 0, y: 0, c: 1, s: 0, contact: 0, tumble: 0 };
  private chunk = 0;
  private maxDist = 0;
  private tumble = 0;
  private slow = 1;
  private readonly frameDt: number;
  private readonly startY: number;

  constructor(private scene: CanalScene, readonly course: EndlessCourse, readonly trace: EndlessTrace, private finalDistance: number) {
    this.frameDt = SIM.dt * trace.every;
    this.startY = course.chunk(0).startY;
    this.apply(0);
  }

  get duration(): number {
    return (this.trace.frameCount - 1) * this.frameDt;
  }

  /** 詰まった時刻（秒） */
  get stopTime(): number {
    return this.trace.stopFrame * this.frameDt;
  }

  /** 詰まった瞬間まで飛ばす（そこからは見守る） */
  skipToStop(): void {
    if (this.phase === 'countdown') this.setPhase('running');
    if (this.t < this.stopTime) this.t = this.stopTime;
  }

  skipAll(): void {
    this.t = this.duration;
    this.setPhase('done');
  }

  private setPhase(p: EndlessPhase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.onPhase?.(p);
  }

  update(dt: number): void {
    // 滝の落ち口の前後は少しゆっくり（×1 のときだけ）
    let target = 1;
    if (this.speed === 1 && this.phase === 'running') {
      for (const d of this.course.chunk(this.chunk).drops) {
        const u = this.pose.y - d.y;
        if (u > -8 && u < 14) target = 0.45;
      }
    }
    this.slow += (target - this.slow) * Math.min(1, dt * 6);
    const step = dt * this.speed * (this.phase === 'running' ? this.slow : 1);
    this.phaseTime += step;
    if (this.phase === 'countdown') {
      const n = Math.ceil(COUNTDOWN - this.phaseTime);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        this.onCount?.(n);
      }
      if (this.phaseTime >= COUNTDOWN) {
        this.onCount?.(0);
        this.setPhase('running');
      }
    } else if (this.phase === 'running' || this.phase === 'stopped') {
      this.t += step;
      if (this.phase === 'running' && this.t >= this.stopTime) this.setPhase('stopped');
      if (this.t >= this.duration) this.setPhase('done');
    }
    this.apply(dt * this.speed);
  }

  private apply(dt: number): void {
    const f = this.trace.frames;
    const t = Math.min(this.t, this.duration);
    const pos = t / this.frameDt;
    let i = Math.floor(pos);
    const last = this.trace.frameCount - 1;
    if (i > last) i = last;
    const j = i < last ? i + 1 : i;
    const u = pos - i;
    const k0 = i * 6;
    const k1 = j * 6;
    // 区間をまたぐフレームは補間しない（座標が区間ごとに違うため）
    const same = f[k0] === f[k1];
    const k = same ? k0 : k1;
    const w = same ? u : 0;
    const chunk = f[k];
    const p = this.pose;
    p.x = f[k + 1] + (same ? (f[k1 + 1] - f[k0 + 1]) * w : 0);
    p.y = f[k + 2] + (same ? (f[k1 + 2] - f[k0 + 2]) * w : 0);
    let c = f[k + 3] + (same ? (f[k1 + 3] - f[k0 + 3]) * w : 0);
    let s = f[k + 4] + (same ? (f[k1 + 4] - f[k0 + 4]) * w : 0);
    const n = Math.sqrt(c * c + s * s) || 1;
    c /= n;
    s /= n;
    p.c = c;
    p.s = s;
    p.contact = f[k + 5];
    this.chunk = chunk;

    if (chunk !== this.shownChunk) {
      this.shownChunk = chunk;
      this.scene.setCourse(this.course.chunk(chunk));
      this.onChunk?.(chunk);
    }

    // 滝壺の逆流の中では縦に回り続ける。抜けたら近いほうの向きへ戻す
    let inRoller = false;
    for (const d of this.course.chunk(chunk).drops) {
      if (d.roll && p.y > d.y + 0.5 && p.y < d.y + d.roll + 1) inRoller = true;
    }
    if (inRoller && this.phase !== 'countdown') this.tumble += dt * 7;
    else {
      const rest = Math.round(this.tumble / TWO_PI) * TWO_PI;
      this.tumble += (rest - this.tumble) * Math.min(1, dt * 5);
    }
    p.tumble = this.tumble;
    this.scene.setPose(0, p);

    const d = this.course.offset(chunk) + p.y - this.startY;
    // 詰まった後は記録の距離で止める（飛ばしたときも正しい距離を出す）
    if (t >= this.stopTime) this.maxDist = this.finalDistance;
    else if (d > this.maxDist) this.maxDist = d;
    this.onTick?.({ phase: this.phase, t, chunk, distance: this.maxDist, pose: p });
  }
}

/** 流す位置 lane の、水路の中心からの横位置（cm） */
export function endlessLaneX(lane: number, halfWidth: number): number {
  return (lane / ENDLESS.laneSteps) * halfWidth * ENDLESS.laneSpan;
}
