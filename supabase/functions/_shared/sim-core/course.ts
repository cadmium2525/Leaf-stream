// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/**
 * コース（用水路）定義と、勝敗に使う 2D 流速場。
 * 水路は x=0 を中心線とし、+y が下流。単位は cm・秒。
 * GPU 水面シェーダーの波はここに一切関与しない。
 */
import { Rng, hashSeed, latticeNoise } from './prng.ts';

export interface Stone {
  x: number;
  y: number;
  r: number;
  /** 正面のよどみ点で流れが左右どちらへ逃げるか（-1..1）。葉の張り付きを防ぐ */
  bias: number;
}

export interface Eddy {
  x: number;
  y: number;
  r: number;
  /** 最大接線速度 cm/s（符号が回転方向） */
  s: number;
}

export interface CoursePreset {
  id: string;
  name: string;
  description: string;
  length: number;
  baseHalfWidth: number;
  widthJitter: number;
  /** 平均流速 cm/s（基準幅のとき） */
  baseSpeed: number;
  stoneCount: [number, number];
  stoneRadius: [number, number];
  eddyCount: [number, number];
  noiseAmp: number;
}

export const COURSE_PRESETS: CoursePreset[] = [
  {
    id: 'tanbo',
    name: '田んぼの用水路',
    description: '素直な流れ。幅の変化と小石がいくつか。',
    length: 760,
    baseHalfWidth: 22,
    widthJitter: 5,
    baseSpeed: 42,
    stoneCount: [4, 6],
    stoneRadius: [3, 6],
    eddyCount: [1, 2],
    noiseAmp: 0.08,
  },
  {
    id: 'jutaku',
    name: '住宅街の側溝',
    description: '細くて速い。絞りの区間で差がつく。',
    length: 820,
    baseHalfWidth: 17,
    widthJitter: 4,
    baseSpeed: 50,
    stoneCount: [3, 5],
    stoneRadius: [2.5, 4.5],
    eddyCount: [1, 3],
    noiseAmp: 0.1,
  },
  {
    id: 'yamazato',
    name: '山里の小川',
    description: '石と渦が多い。形の差が出やすい。',
    length: 700,
    baseHalfWidth: 26,
    widthJitter: 7,
    baseSpeed: 38,
    stoneCount: [7, 10],
    stoneRadius: [3, 7.5],
    eddyCount: [2, 4],
    noiseAmp: 0.14,
  },
];

export const COURSE_IDS = COURSE_PRESETS.map((c) => c.id);

export interface Course {
  id: string;
  name: string;
  seed: number;
  length: number;
  startY: number;
  goalY: number;
  widthStep: number;
  /** y = i*widthStep での半幅 */
  halfWidths: number[];
  /** 流量（半幅 × 流速）。狭いところほど速い */
  flowRate: number;
  baseSpeed: number;
  stones: Stone[];
  eddies: Eddy[];
  noiseAmp: number;
  noiseSeedA: number;
  noiseSeedB: number;
}

export function getPreset(courseId: string): CoursePreset {
  const p = COURSE_PRESETS.find((c) => c.id === courseId);
  if (!p) throw new Error(`unknown course: ${courseId}`);
  return p;
}

/** コース ID とシードからコースを決定論的に生成する */
export function generateCourse(courseId: string, seed: number): Course {
  const preset = getPreset(courseId);
  const rng = new Rng(hashSeed('course', courseId, seed >>> 0));
  const widthStep = 80;
  const nW = Math.floor(preset.length / widthStep) + 2;
  const halfWidths: number[] = [];
  for (let i = 0; i < nW; i++) {
    // スタート付近は基準幅で揃える
    const j = i <= 1 ? 0 : rng.range(-preset.widthJitter, preset.widthJitter);
    halfWidths.push(preset.baseHalfWidth + j);
  }
  const startY = 30;
  const goalY = preset.length - 30;

  const course: Course = {
    id: preset.id,
    name: preset.name,
    seed: seed >>> 0,
    length: preset.length,
    startY,
    goalY,
    widthStep,
    halfWidths,
    flowRate: preset.baseHalfWidth * preset.baseSpeed,
    baseSpeed: preset.baseSpeed,
    stones: [],
    eddies: [],
    noiseAmp: preset.noiseAmp,
    noiseSeedA: hashSeed('noiseA', courseId, seed >>> 0),
    noiseSeedB: hashSeed('noiseB', courseId, seed >>> 0),
  };

  const stoneN = rng.int(preset.stoneCount[0], preset.stoneCount[1]);
  let tries = 0;
  while (course.stones.length < stoneN && tries++ < 400) {
    const r = rng.range(preset.stoneRadius[0], preset.stoneRadius[1]);
    const y = rng.range(startY + 90, goalY - 40);
    const w = halfWidthAt(course, y);
    const x = rng.range(-w + r * 0.5, w - r * 0.5);
    const bias = rng.range(0.3, 0.6) * (rng.next() < 0.5 ? -1 : 1);
    // 隙間は「葉が通れる幅」か「岸に埋まって通れない」のどちらかにする（中途半端な挟まりを作らない）
    const gapL = x - r + w;
    const gapR = w - (x + r);
    const okSide = (g: number) => g >= 11 || g <= 0;
    if (!okSide(gapL) || !okSide(gapR) || Math.max(gapL, gapR) < 13) continue;
    // 石同士の間隔
    let ok = true;
    for (const s of course.stones) {
      const dx = s.x - x;
      const dy = s.y - y;
      const minD = s.r + r + 12;
      if (dx * dx + dy * dy < minD * minD) ok = false;
    }
    if (ok) course.stones.push({ x, y, r, bias });
  }
  course.stones.sort((a, b) => a.y - b.y);

  const eddyN = rng.int(preset.eddyCount[0], preset.eddyCount[1]);
  for (let i = 0; i < eddyN; i++) {
    const y = rng.range(startY + 70, goalY - 30);
    const w = halfWidthAt(course, y);
    const r = rng.range(6, 12);
    const x = rng.range(-w * 0.6, w * 0.6);
    const s = rng.range(0.25, 0.5) * preset.baseSpeed * (rng.next() < 0.5 ? -1 : 1);
    course.eddies.push({ x, y, r, s });
  }
  course.eddies.sort((a, b) => a.y - b.y);
  return course;
}

export function halfWidthAt(c: Course, y: number): number {
  const f = y / c.widthStep;
  let i = Math.floor(f);
  if (i < 0) return c.halfWidths[0];
  if (i >= c.halfWidths.length - 1) return c.halfWidths[c.halfWidths.length - 1];
  const t = f - i;
  // smoothstep で幅を滑らかに補間
  const s = t * t * (3 - 2 * t);
  const w0 = c.halfWidths[i];
  i += 1;
  return w0 + (c.halfWidths[i] - w0) * s;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = latticeNoise(seed, ix, iy);
  const b = latticeNoise(seed, ix + 1, iy);
  const c = latticeNoise(seed, ix, iy + 1);
  const d = latticeNoise(seed, ix + 1, iy + 1);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** 位置 (x,y)・時刻 t の近くに影響する石・渦を集める */
export interface FeatureSet {
  stones: Stone[];
  eddies: Eddy[];
}

export function gatherFeatures(c: Course, y: number, radius: number, out: FeatureSet): void {
  out.stones.length = 0;
  out.eddies.length = 0;
  for (const s of c.stones) {
    const reach = s.r * 6 + radius;
    if (s.y > y - reach && s.y < y + reach) out.stones.push(s);
  }
  for (const e of c.eddies) {
    const reach = e.r * 3 + radius;
    if (e.y > y - reach && e.y < y + reach) out.eddies.push(e);
  }
}

const NOISE_SCALE = 1 / 18;

/**
 * 流速場。out[0]=vx, out[1]=vy に書き込む。
 * ベース流（岸付近で減速・狭いところで加速）＋石まわりのポテンシャル流と後流＋渦＋流れに乗るノイズ。
 */
export function flowAt(c: Course, f: FeatureSet, x: number, y: number, t: number, out: [number, number]): void {
  const w = halfWidthAt(c, y);
  const u0 = c.flowRate / w;
  let d = x / w;
  if (d < 0) d = -d;
  let prof: number;
  if (d >= 1) prof = 0.35;
  else {
    const d2 = d * d;
    prof = 1 - 0.65 * d2 * d2 * d2;
  }
  let vx = 0;
  let vy = u0 * prof;

  for (const s of f.stones) {
    const a = y - s.y; // 下流方向
    const b = x - s.x; // 横方向
    const r2 = a * a + b * b;
    const R2 = s.r * s.r;
    if (r2 < R2) {
      vx = 0;
      vy = 0;
      continue;
    }
    if (r2 > 36 * R2) continue;
    const r4 = r2 * r2;
    const U = vy;
    // 円柱まわりのポテンシャル流（摂動分）
    vy += -U * R2 * (a * a - b * b) / r4;
    vx += -2 * U * R2 * a * b / r4;
    // 正面ではわずかに横へ逃がす
    if (a < 0) vx += s.bias * U * R2 / r2;
    // 下流の後流で減速
    if (a > 0) {
      const ka = a / (4 * s.r);
      const kb = b / (1.6 * s.r);
      const lat = 1 - kb * kb;
      if (lat > 0) vy -= U * 0.45 * lat / (1 + ka * ka);
    }
  }

  for (const e of f.eddies) {
    const dx = x - e.x;
    const dy = y - e.y;
    const r2 = dx * dx + dy * dy;
    const R2 = e.r * e.r;
    if (r2 > 9 * R2) continue;
    const k = r2 / (9 * R2);
    const taper = 1 - k * k;
    // v_t = 2 s R r / (r² + R²)、接線方向は (-dy, dx)/r
    const g = (2 * e.s * e.r) / (r2 + R2) * taper;
    vx += -dy * g;
    vy += dx * g;
  }

  // 流れに乗って下流へ流れる乱れ（凍結乱流）
  const ny = (y - c.baseSpeed * t) * NOISE_SCALE;
  const nx = x * NOISE_SCALE;
  const amp = c.noiseAmp * u0;
  vx += amp * valueNoise(c.noiseSeedA, nx, ny);
  vy += amp * 0.6 * valueNoise(c.noiseSeedB, nx, ny);

  out[0] = vx;
  out[1] = vy;
}
