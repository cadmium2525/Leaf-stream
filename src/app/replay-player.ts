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
const LINGER = 1.2;
const INTERLUDE = 2.2;

export class ReplayPlayer {
  phase: Phase;
  run = 0;
  t = 0;
  speed = 1;
  onTick: ((s: PlayerTick) => void) | null = null;
  onPhase: ((p: Phase, run: number) => void) | null = null;
  onContact: ((strength: number) => void) | null = null;

  private phaseTime = 0;
  private poses: [LeafPose, LeafPose] = [
    { x: 0, y: 0, c: 1, s: 0, contact: 0 },
    { x: 0, y: 0, c: 1, s: 0, contact: 0 },
  ];
  private lastContact = [0, 0];

  constructor(
    private scene: CanalScene,
    readonly replay: RaceReplay,
    readonly result: RaceResult,
    opts: { countdown?: boolean } = {},
  ) {
    this.phase = opts.countdown === false ? 'running' : 'countdown';
    this.applyPoses();
  }

  get duration(): number {
    return traceDuration(this.replay.traces[this.run]);
  }

  skipRun(): void {
    if (this.phase === 'running' || this.phase === 'countdown') {
      this.t = this.duration;
      this.phase = 'running';
      this.phaseTime = 0;
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
    const step = dt * this.speed;
    this.phaseTime += step;
    if (this.phase === 'countdown') {
      if (this.phaseTime >= COUNTDOWN) this.setPhase('running');
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
        this.setPhase('running');
      }
    }
    this.applyPoses();
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
      const c = this.poses[i].contact;
      if (c > 1.2 && this.lastContact[i] <= 1.2) this.onContact?.(c);
      this.lastContact[i] = c;
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
