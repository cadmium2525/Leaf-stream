// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/**
 * 決定論的レースシミュレータ。
 * - 固定 dt（1/60 秒）、更新順序固定、描画フレームとは独立
 * - 使用する演算は + - * / sqrt と整数演算のみ
 * - 2 枚の葉は互いに干渉しない（ゴースト）。同じ水を同時に流れる
 */
import { centroid, polarMoment, pointInPolygon, bounds, area, type Polygon } from './geometry.ts';
import { flowAt, gatherFeatures, generateCourse, halfWidthAt, type Course, type FeatureSet } from './course.ts';

export const SIM_VERSION = '1.0.0';

export const SIM = {
  dt: 1 / 60,
  /** 1 走の制限時間（tick） */
  timeLimitTicks: 75 * 60,
  /** ゴールできなかった走に加算されるペナルティ（tick） */
  penaltyTicks: 15 * 60,
  /** この時間内に下流へ stuckMinProgress cm 進めなければ「詰まり」 */
  stuckWindowTicks: 8 * 60,
  stuckMinProgress: 4,
  /** 合計時間の差がこれ以下なら引き分け（tick） */
  drawThresholdTicks: 2,
  /** 軌跡の記録間隔（tick） */
  traceEvery: 2,
  /** 面密度 */
  density: 0.12,
  /** 葉の裏面と水の線形抵抗係数 */
  underDrag: 0.3,
  /** 葉の縁の圧力抵抗係数 */
  edgeDrag: 0.028,
  /** 縁の接線方向の摩擦 */
  edgeSkin: 0.004,
  restitution: 0.15,
  friction: 0.2,
  interiorSpacing: 1.5,
  /** スタート位置（半幅に対する横位置の比） */
  startLane: 0.45,
} as const;

/** 物理計算用に前処理した葉 */
export interface LeafBody {
  /** 重心を原点にしたローカル外形 */
  verts: Polygon;
  area: number;
  mass: number;
  inertia: number;
  radius: number;
  /** 内部サンプル点 [x, y, 重み(面積)] */
  samples: number[];
  /** 辺 [長さ, 外向き法線x, 法線y] */
  edges: number[];
}

export function prepareLeaf(poly: Polygon): LeafBody {
  const [gx, gy] = centroid(poly);
  const verts: Polygon = poly.map(([x, y]) => [x - gx, y - gy]);
  const a = area(verts);
  const mass = SIM.density * a;
  const inertia = SIM.density * polarMoment(verts);
  let radius = 0;
  for (const [x, y] of verts) {
    const r = Math.sqrt(x * x + y * y);
    if (r > radius) radius = r;
  }
  const b = bounds(verts);
  const h = SIM.interiorSpacing;
  const pts: number[] = [];
  // 格子は重心原点で h の倍数に揃える（決定論的）
  const i0 = Math.floor(b.minX / h);
  const i1 = Math.floor(b.maxX / h) + 1;
  const j0 = Math.floor(b.minY / h);
  const j1 = Math.floor(b.maxY / h) + 1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * h;
      const y = (j + 0.5) * h;
      if (pointInPolygon(verts, x, y)) pts.push(x, y);
    }
  }
  if (pts.length === 0) pts.push(0, 0);
  const n = pts.length / 2;
  const samples: number[] = [];
  for (let k = 0; k < n; k++) samples.push(pts[2 * k], pts[2 * k + 1], a / n);

  const edges: number[] = [];
  for (let i = 0, m = verts.length; i < m; i++) {
    const [x0, y0] = verts[i];
    const [x1, y1] = verts[(i + 1) % m];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    // 反時計回りなので外向き法線は (dy, -dx)
    edges.push(len, len > 0 ? dy / len : 0, len > 0 ? -dx / len : 0);
  }
  return { verts, area: a, mass, inertia, radius, samples, edges };
}

export type RunStatus = 'running' | 'finished' | 'timeout' | 'stuck';

interface BodyState {
  leaf: LeafBody;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 向き（単位複素数）。ローカル +y が世界のどちらを向くか */
  c: number;
  s: number;
  w: number;
  status: RunStatus;
  finishTick: number;
  bestY: number;
  progressTick: number;
  /** 直近の接触の強さ（演出用） */
  contact: number;
  /** 作業用バッファ */
  wx: Float64Array;
  wy: Float64Array;
  ux: Float64Array;
  uy: Float64Array;
}

function makeState(leaf: LeafBody, x: number, y: number): BodyState {
  const nv = leaf.verts.length;
  return {
    leaf, x, y, vx: 0, vy: 0, c: 1, s: 0, w: 0,
    status: 'running', finishTick: -1, bestY: y, progressTick: 0, contact: 0,
    wx: new Float64Array(nv), wy: new Float64Array(nv), ux: new Float64Array(nv), uy: new Float64Array(nv),
  };
}

const tmp: [number, number] = [0, 0];

function applyContact(b: BodyState, px: number, py: number, nx: number, ny: number, pen: number): void {
  // 位置の押し戻し（めり込みを残さない）
  b.x += nx * (pen + 0.01);
  b.y += ny * (pen + 0.01);
  const rx = px - b.x;
  const ry = py - b.y;
  const vpx = b.vx - b.w * ry;
  const vpy = b.vy + b.w * rx;
  const vn = vpx * nx + vpy * ny;
  if (vn >= 0) return;
  const invM = 1 / b.leaf.mass;
  const invI = 1 / b.leaf.inertia;
  const rn = rx * ny - ry * nx;
  const j = (-(1 + SIM.restitution) * vn) / (invM + rn * rn * invI);
  b.vx += j * nx * invM;
  b.vy += j * ny * invM;
  b.w += rn * j * invI;
  // 摩擦
  const tx = -ny;
  const ty = nx;
  const vpx2 = b.vx - b.w * ry;
  const vpy2 = b.vy + b.w * rx;
  const vt = vpx2 * tx + vpy2 * ty;
  const rt = rx * ty - ry * tx;
  let jt = -vt / (invM + rt * rt * invI);
  const maxF = SIM.friction * j;
  if (jt > maxF) jt = maxF;
  if (jt < -maxF) jt = -maxF;
  b.vx += jt * tx * invM;
  b.vy += jt * ty * invM;
  b.w += rt * jt * invI;
  if (j > b.contact) b.contact = j;
}

function updateWorldVerts(b: BodyState): void {
  const v = b.leaf.verts;
  for (let i = 0; i < v.length; i++) {
    const lx = v[i][0];
    const ly = v[i][1];
    // 角度 θ（c=cosθ, s=sinθ）で回転：x' = c*lx - s*ly, y' = s*lx + c*ly
    b.wx[i] = b.x + b.c * lx - b.s * ly;
    b.wy[i] = b.y + b.s * lx + b.c * ly;
  }
}

function stepBody(course: Course, b: BodyState, f: FeatureSet, t: number): void {
  const L = b.leaf;
  const dt = SIM.dt;
  gatherFeatures(course, b.y, L.radius, f);
  updateWorldVerts(b);

  let fx = 0;
  let fy = 0;
  let tq = 0;

  // 裏面の抵抗（内部サンプル点ごとの相対流速）
  const smp = L.samples;
  for (let k = 0; k < smp.length; k += 3) {
    const rx = b.c * smp[k] - b.s * smp[k + 1];
    const ry = b.s * smp[k] + b.c * smp[k + 1];
    flowAt(course, f, b.x + rx, b.y + ry, t, tmp);
    const relx = tmp[0] - (b.vx - b.w * ry);
    const rely = tmp[1] - (b.vy + b.w * rx);
    const k2 = SIM.underDrag * smp[k + 2];
    const px = k2 * relx;
    const py = k2 * rely;
    fx += px;
    fy += py;
    tq += rx * py - ry * px;
  }

  // 縁の抵抗（頂点の流速の平均を辺の中点の流速とする）
  const nv = L.verts.length;
  for (let i = 0; i < nv; i++) {
    flowAt(course, f, b.wx[i], b.wy[i], t, tmp);
    b.ux[i] = tmp[0];
    b.uy[i] = tmp[1];
  }
  const e = L.edges;
  for (let i = 0; i < nv; i++) {
    const j = i + 1 === nv ? 0 : i + 1;
    const len = e[3 * i];
    if (len === 0) continue;
    const mx = (b.wx[i] + b.wx[j]) * 0.5;
    const my = (b.wy[i] + b.wy[j]) * 0.5;
    const rx = mx - b.x;
    const ry = my - b.y;
    const nx = b.c * e[3 * i + 1] - b.s * e[3 * i + 2];
    const ny = b.s * e[3 * i + 1] + b.c * e[3 * i + 2];
    const relx = (b.ux[i] + b.ux[j]) * 0.5 - (b.vx - b.w * ry);
    const rely = (b.uy[i] + b.uy[j]) * 0.5 - (b.vy + b.w * rx);
    const rn = relx * nx + rely * ny;
    let px = 0;
    let py = 0;
    if (rn < 0) {
      const p = SIM.edgeDrag * len * rn * rn;
      px = -p * nx;
      py = -p * ny;
    }
    // 接線方向の摩擦
    const rt = relx * -ny + rely * nx;
    const st = SIM.edgeSkin * len * rt;
    px += st * -ny;
    py += st * nx;
    fx += px;
    fy += py;
    tq += rx * py - ry * px;
  }

  // 半陰的オイラー
  b.vx += (fx / L.mass) * dt;
  b.vy += (fy / L.mass) * dt;
  b.w += (tq / L.inertia) * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  const th = b.w * dt;
  const nc = b.c - b.s * th;
  const ns = b.s + b.c * th;
  const norm = Math.sqrt(nc * nc + ns * ns);
  b.c = nc / norm;
  b.s = ns / norm;

  // 衝突（2 反復）
  b.contact *= 0.9;
  for (let iter = 0; iter < 2; iter++) {
    updateWorldVerts(b);
    // 河岸：左右それぞれ最も深い頂点
    let pl = 0;
    let il = -1;
    let pr = 0;
    let ir = -1;
    for (let i = 0; i < nv; i++) {
      const w = halfWidthAt(course, b.wy[i]);
      const dl = -w - b.wx[i];
      const dr = b.wx[i] - w;
      if (dl > pl) {
        pl = dl;
        il = i;
      }
      if (dr > pr) {
        pr = dr;
        ir = i;
      }
    }
    if (il >= 0) applyContact(b, b.wx[il], b.wy[il], 1, 0, pl);
    if (ir >= 0) applyContact(b, b.wx[ir], b.wy[ir], -1, 0, pr);

    // 石：円とポリゴンの最近点
    for (const s of f.stones) {
      const dx0 = s.x - b.x;
      const dy0 = s.y - b.y;
      const reach = s.r + L.radius;
      if (dx0 * dx0 + dy0 * dy0 > reach * reach) continue;
      // 石の中心をローカル座標へ
      const lx = b.c * dx0 + b.s * dy0;
      const ly = -b.s * dx0 + b.c * dy0;
      let best = Infinity;
      let qx = 0;
      let qy = 0;
      const v = L.verts;
      for (let i = 0; i < nv; i++) {
        const j = i + 1 === nv ? 0 : i + 1;
        const ax = v[i][0];
        const ay = v[i][1];
        const ex = v[j][0] - ax;
        const ey = v[j][1] - ay;
        const ee = ex * ex + ey * ey;
        let u = ee > 0 ? ((lx - ax) * ex + (ly - ay) * ey) / ee : 0;
        if (u < 0) u = 0;
        if (u > 1) u = 1;
        const cx = ax + ex * u;
        const cy = ay + ey * u;
        const d2 = (lx - cx) * (lx - cx) + (ly - cy) * (ly - cy);
        if (d2 < best) {
          best = d2;
          qx = cx;
          qy = cy;
        }
      }
      const d = Math.sqrt(best);
      const inside = pointInPolygon(v, lx, ly);
      if (!inside && d >= s.r) continue;
      // 世界座標の接触点
      const wqx = b.x + b.c * qx - b.s * qy;
      const wqy = b.y + b.s * qx + b.c * qy;
      let nx: number;
      let ny: number;
      let pen: number;
      if (d < 1e-9) {
        nx = -dx0;
        ny = -dy0;
        const nn = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nn;
        ny /= nn;
        pen = s.r;
      } else if (inside) {
        // 中心が葉の内側：葉は q→中心 の向きへ逃がす
        nx = (s.x - wqx) / d;
        ny = (s.y - wqy) / d;
        pen = d + s.r;
      } else {
        nx = (wqx - s.x) / d;
        ny = (wqy - s.y) / d;
        pen = s.r - d;
      }
      applyContact(b, wqx, wqy, nx, ny, pen);
    }
  }
}

export interface LeafRunResult {
  status: Exclude<RunStatus, 'running'>;
  /** ゴールした tick（ゴールしていなければ -1） */
  finishTick: number;
  /** 判定用の時間（tick）。未完走は制限時間＋ペナルティ */
  scoreTicks: number;
}

export interface RunTrace {
  /** 1 フレーム 10 値：[x, y, c, s, contact] × 2 枚 */
  frames: Float32Array;
  frameCount: number;
  every: number;
}

/**
 * 1 走ぶんのシミュレータ。step() を任意の回数ずつ呼べる（描画フレームとは独立）。
 * leaves[0] が左レーン、leaves[1] が右レーン。
 */
export class RunSim {
  readonly course: Course;
  tick = 0;
  private bodies: BodyState[];
  private features: FeatureSet[] = [{ stones: [], eddies: [] }, { stones: [], eddies: [] }];
  private trace: number[] = [];

  constructor(course: Course, left: LeafBody, right: LeafBody) {
    this.course = course;
    const w = halfWidthAt(course, course.startY);
    this.bodies = [
      makeState(left, -w * SIM.startLane, course.startY),
      makeState(right, w * SIM.startLane, course.startY),
    ];
    this.record();
  }

  get done(): boolean {
    return this.bodies.every((b) => b.status !== 'running');
  }

  private record(): void {
    for (const b of this.bodies) this.trace.push(b.x, b.y, b.c, b.s, b.contact);
  }

  step(n = 1): void {
    for (let k = 0; k < n && !this.done; k++) {
      const t = this.tick * SIM.dt;
      for (let i = 0; i < 2; i++) {
        const b = this.bodies[i];
        if (b.status !== 'running') continue;
        stepBody(this.course, b, this.features[i], t);
      }
      this.tick++;
      for (const b of this.bodies) {
        if (b.status !== 'running') continue;
        if (b.y >= this.course.goalY) {
          b.status = 'finished';
          b.finishTick = this.tick;
          continue;
        }
        if (b.y > b.bestY + SIM.stuckMinProgress) {
          b.bestY = b.y;
          b.progressTick = this.tick;
        } else if (this.tick - b.progressTick > SIM.stuckWindowTicks) {
          b.status = 'stuck';
          continue;
        }
        if (this.tick >= SIM.timeLimitTicks) b.status = 'timeout';
      }
      if (this.tick % SIM.traceEvery === 0 || this.done) this.record();
    }
  }

  results(): [LeafRunResult, LeafRunResult] {
    return this.bodies.map((b) => {
      const status = b.status === 'running' ? 'timeout' : b.status;
      return {
        status,
        finishTick: b.finishTick,
        scoreTicks: status === 'finished' ? b.finishTick : SIM.timeLimitTicks + SIM.penaltyTicks,
      };
    }) as [LeafRunResult, LeafRunResult];
  }

  /** 現在の姿勢（描画・プレビュー用）。lane 0=左, 1=右 */
  pose(lane: 0 | 1): { x: number; y: number; c: number; s: number; contact: number } {
    const b = this.bodies[lane];
    return { x: b.x, y: b.y, c: b.c, s: b.s, contact: b.contact };
  }

  getTrace(): RunTrace {
    return { frames: Float32Array.from(this.trace), frameCount: this.trace.length / 10, every: SIM.traceEvery };
  }
}

export type RaceOutcome = 'challenger_win' | 'defender_win' | 'draw';

export interface RaceInput {
  courseId: string;
  seed: number;
  /** 挑戦側（A） */
  challenger: Polygon;
  /** 防衛側（B） */
  defender: Polygon;
}

export interface RaceResult {
  simVersion: string;
  outcome: RaceOutcome;
  /** 合計判定時間（tick） */
  timeA: number;
  timeB: number;
  /** runs[0]: A 左 / B 右、runs[1]: B 左 / A 右。各走の [A, B] の結果 */
  runs: [LeafRunResult, LeafRunResult][];
}

export interface RaceReplay {
  course: Course;
  /** runs[r] のトレース。leafIndex 0/1 は「左/右」なので laneOf で A/B を引く */
  traces: RunTrace[];
}

/** 走 r で A（挑戦側）がどちらのレーンか（0=左, 1=右） */
export function laneOfChallenger(run: number): 0 | 1 {
  return run === 0 ? 0 : 1;
}

export function judge(timeA: number, timeB: number, allDnf: boolean): RaceOutcome {
  if (allDnf) return 'draw';
  const d = timeA - timeB;
  if (d > SIM.drawThresholdTicks) return 'defender_win';
  if (d < -SIM.drawThresholdTicks) return 'challenger_win';
  return 'draw';
}

/**
 * 公式レース：スタート位置を左右入れ替えた 2 走の合計時間で判定する。
 * サーバーの確定処理とクライアントの観戦で同じ関数を使う。
 */
export function simulateRace(input: RaceInput, withTrace = false): { result: RaceResult; replay?: RaceReplay } {
  const course = generateCourse(input.courseId, input.seed);
  const A = prepareLeaf(input.challenger);
  const B = prepareLeaf(input.defender);
  const runs: [LeafRunResult, LeafRunResult][] = [];
  const traces: RunTrace[] = [];
  for (let r = 0; r < 2; r++) {
    const laneA = laneOfChallenger(r);
    const sim = laneA === 0 ? new RunSim(course, A, B) : new RunSim(course, B, A);
    while (!sim.done) sim.step(600);
    const res = sim.results();
    runs.push(laneA === 0 ? [res[0], res[1]] : [res[1], res[0]]);
    if (withTrace) traces.push(sim.getTrace());
  }
  const timeA = runs[0][0].scoreTicks + runs[1][0].scoreTicks;
  const timeB = runs[0][1].scoreTicks + runs[1][1].scoreTicks;
  const allDnf = runs.every((r) => r[0].status !== 'finished' && r[1].status !== 'finished');
  const result: RaceResult = { simVersion: SIM_VERSION, outcome: judge(timeA, timeB, allDnf), timeA, timeB, runs };
  return withTrace ? { result, replay: { course, traces } } : { result };
}

export function ticksToSeconds(t: number): number {
  return t * SIM.dt;
}
