/**
 * 確定済みレース（2 走）の再生制御。描画 fps に関係なく、軌跡を時刻で補間して表示する。
 */
import {
  laneOfChallenger, samplePose, traceDuration, type LeafPose, type RaceReplay, type RaceResult,
} from '../../packages/sim-core/src/index.ts';
import type { CanalScene } from '../render/scene.ts';

export type Phase = 'countdown' | 'running' | 'interlude' | 'done';

export interface PlayerTick {
  phase: Phase;
  run: number;
  /** 走の経過秒 */
  t: number;
  countdown: number;
  poses: [LeafPose, LeafPose];
  /** 各葉がこの走でゴールしたか（表示時刻までに） */
  finished: [boolean, boolean];
}

const COUNTDOWN = 3;
/** 軌跡にはゴール後の流れも入っているので、終わりの余韻は短く */
const LINGER = 0.3;
const INTERLUDE = 1.6;

export class ReplayPlayer {
  phase: Phase;
  run = 0;
  t = 0;
  speed = 1;
  onTick: ((s: PlayerTick) => void) | null = null;
  onPhase: ((p: Phase, run: number) => void) | null = null;
  /** カウントダウン：3, 2, 1 と、スタートの瞬間に 0 */
  onCount: ((n: number) => void) | null = null;
  /** 滝を越える瞬間にスローモーションにする */
  slowmo = true;

  private phaseTime = 0;
  private poses: [LeafPose, LeafPose] = [
    { x: 0, y: 0, c: 1, s: 0, contact: 0 },
    { x: 0, y: 0, c: 1, s: 0, contact: 0 },
  ];
  private lastCount = -1;
  private slow = 1;
  private useCountdown: boolean;

  constructor(
    private scene: CanalScene,
    readonly replay: RaceReplay,
    readonly result: RaceResult,
    opts: { countdown?: boolean } = {},
  ) {
    this.useCountdown = opts.countdown !== false;
    this.phase = this.useCountdown ? 'countdown' : 'running';
    this.applyPoses();
  }

  get duration(): number {
    return traceDuration(this.replay.traces[this.run]);
  }

  skipRun(): void {
    if (this.phase === 'running' || this.phase === 'countdown') {
      this.t = this.duration;
      if (this.phase === 'countdown') {
        // カウントダウン中に飛ばしたときも、走り出したことを知らせる（2 走目の表示切替など）
        this.lastCount = -1;
        this.setPhase('running');
      } else this.phaseTime = 0;
    }
  }

  skipAll(): void {
    this.run = this.replay.traces.length - 1;
    this.t = this.duration;
    this.setPhase('done');
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.onPhase?.(p, this.run);
  }

  update(dt: number): void {
    // 滝の手前〜着水まで、先頭の 1 枚でも近ければゆっくりにする（×1 のときだけ）
    let target = 1;
    if (this.slowmo && this.speed === 1 && this.phase === 'running') {
      for (const p of this.poses) {
        for (const d of this.replay.course.drops) {
          const u = p.y - d.y;
          if (u > -8 && u < 14) target = 0.35;
        }
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
        this.lastCount = -1;
        this.onCount?.(0);
        this.setPhase('running');
      }
    } else if (this.phase === 'running') {
      this.t += step;
      if (this.t >= this.duration + LINGER) {
        if (this.run + 1 < this.replay.traces.length) this.setPhase('interlude');
        else this.setPhase('done');
      }
    } else if (this.phase === 'interlude') {
      if (this.phaseTime >= INTERLUDE) {
        this.run++;
        this.t = 0;
        // 2 走目もカウントダウンから
        this.setPhase(this.useCountdown ? 'countdown' : 'running');
      }
    }
    this.applyPoses();
  }

  /** 再生中の速さ（スローモーション込み） */
  get timeScale(): number {
    return this.speed * (this.phase === 'running' ? this.slow : 1);
  }

  private applyPoses(): void {
    const tr = this.replay.traces[this.run];
    const laneA = laneOfChallenger(this.run);
    const t = Math.min(this.t, this.duration);
    samplePose(tr, laneA, t, this.poses[0]);
    samplePose(tr, laneA === 0 ? 1 : 0, t, this.poses[1]);
    const runRes = this.result.runs[this.run];
    const finished: [boolean, boolean] = [false, false];
    for (let i = 0; i < 2; i++) {
      this.scene.setPose(i, this.poses[i]);
      const r = runRes[i];
      finished[i] = r.status === 'finished' && t * 60 >= r.finishTick;
    }
    this.onTick?.({
      phase: this.phase,
      run: this.run,
      t,
      countdown: Math.max(0, COUNTDOWN - this.phaseTime),
      poses: this.poses,
      finished,
    });
  }
}
