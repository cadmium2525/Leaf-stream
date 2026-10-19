/**
 * どこまでもモード：詰まるまで流れ続け、進んだ距離を競う。
 * - コースは「区間」を継ぎ目なくつないだもの。区間の両端は同じ幅のまっすぐな水路で、
 *   葉が区間の終わりを越えたら次の区間の頭へ移る（物理はレースと同じ stepBody）
 * - 遠くへ進むほど仕掛け（滝壺の逆流・杭の列）が増え、流れも速くなる
 * - 引っかかっても押し出さない。stuckWindowTicks のあいだ前へ進めなければ終わり
 * - 入力は「週のシード・葉の形・流す位置（左右）」だけ。サーバーが同じ計算で記録を確定する
 */
import { Rng, hashSeed } from './prng.ts';
import { buildCourse, centerAt, getPreset, halfWidthAt, type Course, type FeatureSet } from './course.ts';
import { SIM, makeState, prepareLeaf, stepBody, type BodyState, type LeafBody } from './sim.ts';
import type { Polygon } from './geometry.ts';

export const ENDLESS_VERSION = 'E1.0';

export const ENDLESS = {
  /** 区間の継ぎ目の半幅（cm） */
  joint: 18,
  /** この時間内に stuckMinProgress cm 進めなければ「詰まり」 */
  stuckWindowTicks: 6 * 60,
  stuckMinProgress: 4,
  /** 制限時間（tick）。ここまで流れ切ったら終わり */
  timeLimitTicks: 8 * 60 * 60,
  /** 軌跡の記録間隔（tick） */
  traceEvery: 2,
  /** 観戦用：詰まったあとも流し続ける時間（tick）。記録には影響しない */
  coastTicks: 4 * 60,
  /** 流す位置は -laneSteps..laneSteps の整数（中央が 0） */
  laneSteps: 10,
  /** 一番端の位置が半幅のどこか（比） */
  laneSpan: 0.7,
  /** 難しさが最大になる区間 */
  rampChunks: 10,
} as const;

const STYLE_IDS = ['tanbo', 'jutaku', 'yamazato'];

/** 週キー（例 "2026-W43"）からその週のコースのシードを決める */
export function endlessSeed(weekKey: string): number {
  return hashSeed('endless', weekKey);
}

/** 区間 i の難しさ（0..1） */
export function chunkDifficulty(index: number): number {
  return index >= ENDLESS.rampChunks ? 1 : index / ENDLESS.rampChunks;
}

/** 区間 i のコースを作る。style は区間の見た目（田んぼ・住宅街・山里）の ID */
export function generateChunk(seed: number, index: number, style: string): Course {
  const base = getPreset(style);
  const d = chunkDifficulty(index);
  // 最大の難しさを越えても、杭の隙間と滝壺だけはさらに厳しくなっていく
  const dd = index >= 2 * ENDLESS.rampChunks ? 2 : index / ENDLESS.rampChunks;
  const preset = {
    ...base,
    baseSpeed: base.baseSpeed * (1 + 0.2 * d),
    stoneCount: [base.stoneCount[0] + Math.floor(2 * d), base.stoneCount[1] + Math.floor(3 * d)] as [number, number],
    eddyCount: [base.eddyCount[0], base.eddyCount[1] + Math.floor(2 * d)] as [number, number],
    dropCount: [Math.max(2, base.dropCount[0]), Math.max(2, base.dropCount[1]) + Math.floor(d + 0.5)] as [number, number],
    gateCount: 0,
  };
  const chunkSeed = hashSeed('endless-chunk', seed >>> 0, index);
  const course = buildCourse(preset, chunkSeed, new Rng(chunkSeed), ENDLESS.joint);
  const g = new Rng(hashSeed('endless-gimmick', seed >>> 0, index));

  // 滝壺の逆流：落差を堰（切り欠きなし）にして、落ち口の下に戻り流れを作る
  for (const dr of course.drops) {
    if (g.next() < 0.3 + 0.3 * dd) {
      dr.notchW = 0;
      dr.notchX = centerAt(course, dr.y);
      if (dr.h < 4) dr.h = 4;
      dr.roll = g.range(4 + dd, 6 + 3 * dd);
    }
  }

  // 杭の列：流れを横切って杭が並ぶ。隙間より幅の広い葉は引っかかる
  const rows = index === 0 ? 0 : g.int(1, 1 + Math.floor(1.5 * dd + 0.5));
  const rowYs: number[] = [];
  for (let k = 0; k < rows; k++) {
    for (let tries = 0; tries < 30; tries++) {
      const y = g.range(course.startY + 100, course.goalY - 60);
      if (course.drops.some((dr) => y > dr.y - 45 && y < dr.y + 45)) continue;
      if (course.stones.some((s) => Math.abs(s.y - y) < s.r + 18)) continue;
      if (rowYs.some((ry) => Math.abs(ry - y) < 60)) continue;
      rowYs.push(y);
      const w = halfWidthAt(course, y);
      const c = centerAt(course, y);
      const r = 1;
      const gap = g.range(8.5 - 2 * dd, 10.5 - 2 * dd);
      for (let x = c - w + g.range(0.4, 1) * gap + r; x < c + w - r - 1; x += 2 * r + gap) {
        course.stones.push({ x, y: y + g.range(-1.5, 1.5), r, bias: 0, post: true });
      }
      break;
    }
  }
  course.stones.sort((a, b) => a.y - b.y);
  return course;
}

/** 区間を必要になった順に作って覚えておく（見た目は同じ種類が続かないように選ぶ） */
export class EndlessCourse {
  readonly seed: number;
  private chunks: Course[] = [];
  private styles: string[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  style(i: number): string {
    while (this.styles.length <= i) {
      const n = this.styles.length;
      if (n === 0) {
        this.styles.push('tanbo');
        continue;
      }
      const prev = this.styles[n - 1];
      const others = STYLE_IDS.filter((s) => s !== prev);
      const r = new Rng(hashSeed('endless-style', this.seed, n));
      this.styles.push(others[r.int(0, others.length - 1)]);
    }
    return this.styles[i];
  }

  chunk(i: number): Course {
    while (this.chunks.length <= i) {
      const n = this.chunks.length;
      this.chunks.push(generateChunk(this.seed, n, this.style(n)));
    }
    return this.chunks[i];
  }

  /** 区間 i の頭までの距離（cm） */
  offset(i: number): number {
    let o = 0;
    for (let k = 0; k < i; k++) o += this.chunk(k).length;
    return o;
  }
}

export type EndlessStatus = 'running' | 'stuck' | 'timeout';
/** 詰まった原因（表示用）：滝壺・杭・岩・岸・よどみ・時間切れ */
export type EndlessReason = 'roller' | 'post' | 'stone' | 'bank' | 'eddy' | 'time';

export interface EndlessInput {
  seed: number;
  polygon: Polygon;
  /** 流す位置（-laneSteps..laneSteps） */
  lane: number;
}

export interface EndlessResult {
  version: string;
  status: Exclude<EndlessStatus, 'running'>;
  reason: EndlessReason;
  /** 進んだ距離（cm、整数） */
  distance: number;
  /** 止まった tick */
  ticks: number;
  /** 止まった区間 */
  chunk: number;
}

export interface EndlessTrace {
  /** 1 フレーム 6 値：[区間, x, y, c, s, contact] */
  frames: Float32Array;
  frameCount: number;
  every: number;
  /** 止まったフレーム（以降は観戦用の延長） */
  stopFrame: number;
}

export function isLane(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= -ENDLESS.laneSteps && v <= ENDLESS.laneSteps;
}

export class EndlessSim {
  readonly course: EndlessCourse;
  tick = 0;
  chunk = 0;
  status: EndlessStatus = 'running';
  reason: EndlessReason = 'time';
  private offset = 0;
  private body: BodyState;
  private f: FeatureSet = { stones: [], eddies: [] };
  private startY: number;
  private maxY: number;
  private bestY: number;
  private progressTick = 0;
  private stopTick = -1;
  private stopChunk = 0;
  private tail = 0;
  private coast: boolean;
  private trace: number[] = [];
  private stopFrame = -1;

  constructor(course: EndlessCourse, leaf: LeafBody, lane: number, opts: { coast?: boolean } = {}) {
    this.course = course;
    this.coast = !!opts.coast;
    const c0 = course.chunk(0);
    const w = halfWidthAt(c0, c0.startY);
    const x = centerAt(c0, c0.startY) + (lane / ENDLESS.laneSteps) * w * ENDLESS.laneSpan;
    this.body = makeState(leaf, x, c0.startY);
    this.startY = c0.startY;
    this.maxY = c0.startY;
    this.bestY = c0.startY;
    this.record();
  }

  get done(): boolean {
    return this.status !== 'running' && (!this.coast || this.tail >= ENDLESS.coastTicks);
  }

  /** 現在の区間内の姿勢（描画・プレビュー用） */
  pose(): { chunk: number; x: number; y: number; c: number; s: number; contact: number } {
    const b = this.body;
    return { chunk: this.chunk, x: b.x, y: b.y, c: b.c, s: b.s, contact: b.contact };
  }

  /** ここまでに進んだ距離（cm） */
  get distance(): number {
    return Math.floor(this.maxY - this.startY);
  }

  private record(): void {
    const b = this.body;
    this.trace.push(this.chunk, b.x, b.y, b.c, b.s, b.contact);
  }

  step(n = 1): void {
    for (let k = 0; k < n && !this.done; k++) {
      if (this.status !== 'running') this.tail++;
      const course = this.course.chunk(this.chunk);
      stepBody(course, this.body, this.f, this.tick * SIM.dt, this.tick, false);
      this.tick++;
      // 区間の終わりを越えたら次の区間の頭へ（両端は同じ幅・中心 0 なので位置はそのまま続く）
      if (this.body.y >= course.length) {
        this.body.y -= course.length;
        this.offset += course.length;
        this.chunk++;
      }
      if (this.status === 'running') {
        const gy = this.offset + this.body.y;
        if (gy > this.maxY) this.maxY = gy;
        if (gy > this.bestY + ENDLESS.stuckMinProgress) {
          this.bestY = gy;
          this.progressTick = this.tick;
        } else if (this.tick - this.progressTick > ENDLESS.stuckWindowTicks) {
          this.stop('stuck', this.classify());
        }
        if (this.status === 'running' && this.tick >= ENDLESS.timeLimitTicks) this.stop('timeout', 'time');
      }
      if (this.tick % ENDLESS.traceEvery === 0 || this.done) this.record();
    }
  }

  private stop(status: Exclude<EndlessStatus, 'running'>, reason: EndlessReason): void {
    this.status = status;
    this.reason = reason;
    this.stopTick = this.tick;
    this.stopChunk = this.chunk;
    this.stopFrame = this.trace.length / 6;
  }

  /** 止まった場所から原因を推定する（表示用。記録には影響しない） */
  private classify(): EndlessReason {
    const c = this.course.chunk(this.chunk);
    const b = this.body;
    const R = b.leaf.radius;
    for (const d of c.drops) {
      if (d.roll && b.y > d.y - 4 && b.y < d.y + d.roll + 4) return 'roller';
    }
    let near: { post?: boolean } | null = null;
    for (const s of c.stones) {
      const dx = s.x - b.x;
      const dy = s.y - b.y;
      const reach = s.r + R + 1;
      if (dx * dx + dy * dy < reach * reach) {
        near = s;
        if (s.post) break;
      }
    }
    if (near) return near.post ? 'post' : 'stone';
    const edge = halfWidthAt(c, b.y) - Math.abs(b.x - centerAt(c, b.y));
    return edge < R + 1 ? 'bank' : 'eddy';
  }

  result(): EndlessResult {
    const running = this.status === 'running';
    return {
      version: ENDLESS_VERSION,
      status: running ? 'timeout' : this.status as Exclude<EndlessStatus, 'running'>,
      reason: running ? 'time' : this.reason,
      distance: this.distance,
      ticks: this.stopTick >= 0 ? this.stopTick : this.tick,
      chunk: this.stopTick >= 0 ? this.stopChunk : this.chunk,
    };
  }

  getTrace(): EndlessTrace {
    const frameCount = this.trace.length / 6;
    return { frames: Float32Array.from(this.trace), frameCount, every: ENDLESS.traceEvery, stopFrame: this.stopFrame >= 0 ? this.stopFrame : frameCount - 1 };
  }
}

/** どこまでもモードの公式計算（サーバーの確定とクライアントの観戦で同じ関数を使う） */
export function simulateEndless(input: EndlessInput, withTrace = false): { result: EndlessResult; trace?: EndlessTrace; course: EndlessCourse } {
  const course = new EndlessCourse(input.seed);
  const sim = new EndlessSim(course, prepareLeaf(input.polygon), input.lane, { coast: withTrace });
  while (!sim.done) sim.step(600);
  const result = sim.result();
  return withTrace ? { result, trace: sim.getTrace(), course } : { result, course };
}
