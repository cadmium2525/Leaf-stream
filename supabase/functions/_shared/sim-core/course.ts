// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/**
 * コース（用水路・小川）定義と、勝敗に使う 2D 流速場。
 * +y が下流、x は横方向（中心線は centers で蛇行する）。単位は cm・秒。
 * 落差の高さは流れ方（加速・寄せ・乱れ）だけに効き、3D の高さは描画側で表現する。
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

/** 小さな滝（落差）。上流側で流れが速まり、切り欠きがあればそこへ寄せられ、下流は白く泡立って乱れる */
export interface Drop {
  y: number;
  /** 落差（cm） */
  h: number;
  /** 切り欠き（岩の隙間・堰の欠け）の中心 x。notchW=0 なら切り欠きなし */
  notchX: number;
  notchW: number;
}

/** 側溝のふた（暗渠）。見た目だけで流れには影響しない */
export interface Cover {
  y0: number;
  y1: number;
}

/** 見た目の種類：コンクリート水路／住宅街の側溝／自然の小川 */
export type CourseStyle = 'concrete' | 'gutter' | 'natural';

export interface CoursePreset {
  id: string;
  name: string;
  description: string;
  style: CourseStyle;
  length: number;
  baseHalfWidth: number;
  widthJitter: number;
  /** 中心線の蛇行の振れ幅（cm） */
  meander: number;
  /** 平均流速 cm/s（基準幅のとき） */
  baseSpeed: number;
  stoneCount: [number, number];
  stoneRadius: [number, number];
  eddyCount: [number, number];
  dropCount: [number, number];
  dropHeight: [number, number];
  /** 落差に切り欠きができる確率 */
  notchChance: number;
  coverCount: number;
  noiseAmp: number;
}

export const COURSE_PRESETS: CoursePreset[] = [
  {
    id: 'tanbo',
    name: '田んぼの用水路',
    description: 'コンクリートの用水路。途中の堰で一段落ちる。',
    style: 'concrete',
    length: 780,
    baseHalfWidth: 22,
    widthJitter: 5,
    meander: 0,
    baseSpeed: 42,
    stoneCount: [3, 5],
    stoneRadius: [3, 6],
    eddyCount: [1, 2],
    dropCount: [2, 2],
    dropHeight: [3, 5],
    notchChance: 0.5,
    coverCount: 0,
    noiseAmp: 0.08,
  },
  {
    id: 'jutaku',
    name: '住宅街の側溝',
    description: '細くて速い。段差が続き、ふたの下の暗がりを抜ける。',
    style: 'gutter',
    length: 840,
    baseHalfWidth: 16,
    widthJitter: 3,
    meander: 0,
    baseSpeed: 50,
    stoneCount: [2, 4],
    stoneRadius: [2.5, 4],
    eddyCount: [1, 2],
    dropCount: [3, 3],
    dropHeight: [2.5, 3.5],
    notchChance: 0.2,
    coverCount: 2,
    noiseAmp: 0.1,
  },
  {
    id: 'yamazato',
    name: '山里の小川',
    description: '曲がりくねる自然の小川。岩の隙間の小滝と淵が続く。',
    style: 'natural',
    length: 800,
    baseHalfWidth: 25,
    widthJitter: 9,
    meander: 14,
    baseSpeed: 40,
    stoneCount: [8, 11],
    stoneRadius: [3, 7.5],
    eddyCount: [2, 4],
    dropCount: [3, 3],
    dropHeight: [5, 8],
    notchChance: 1,
    coverCount: 0,
    noiseAmp: 0.14,
  },
];

export const COURSE_IDS = COURSE_PRESETS.map((c) => c.id);

export interface Course {
  id: string;
  name: string;
  style: CourseStyle;
  seed: number;
  length: number;
  startY: number;
  goalY: number;
  widthStep: number;
  /** y = i*widthStep での半幅 */
  halfWidths: number[];
  /** y = i*widthStep での中心線の x */
  centers: number[];
  /** 流量（半幅 × 流速）。狭いところほど速い */
  flowRate: number;
  baseSpeed: number;
  stones: Stone[];
  eddies: Eddy[];
  drops: Drop[];
  covers: Cover[];
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
  const centers: number[] = [];
  let cx = 0;
  for (let i = 0; i < nW; i++) {
    // スタート付近は基準幅・まっすぐで揃える
    const j = i <= 1 ? 0 : rng.range(-preset.widthJitter, preset.widthJitter);
    halfWidths.push(preset.baseHalfWidth + j);
    if (i > 1 && preset.meander > 0) {
      // 振れ幅の中で行ったり来たりする中心線
      cx += rng.range(-preset.meander, preset.meander);
      if (cx > preset.meander) cx = 2 * preset.meander - cx;
      if (cx < -preset.meander) cx = -2 * preset.meander - cx;
    }
    centers.push(i <= 1 ? 0 : cx);
  }
  const startY = 30;
  const goalY = preset.length - 30;

  const course: Course = {
    id: preset.id,
    name: preset.name,
    style: preset.style,
    seed: seed >>> 0,
    length: preset.length,
    startY,
    goalY,
    widthStep,
    halfWidths,
    centers,
    flowRate: preset.baseHalfWidth * preset.baseSpeed,
    baseSpeed: preset.baseSpeed,
    stones: [],
    eddies: [],
    drops: [],
    covers: [],
    noiseAmp: preset.noiseAmp,
    noiseSeedA: hashSeed('noiseA', courseId, seed >>> 0),
    noiseSeedB: hashSeed('noiseB', courseId, seed >>> 0),
  };

  // 落差：区間を等分して、それぞれの中に 1 つ置く
  const dropN = rng.int(preset.dropCount[0], preset.dropCount[1]);
  const span0 = startY + 140;
  const span1 = goalY - 70;
  for (let i = 0; i < dropN; i++) {
    const seg = (span1 - span0) / dropN;
    const y = span0 + seg * i + rng.range(seg * 0.2, seg * 0.8);
    const w = halfWidthAt(course, y);
    const c = centerAt(course, y);
    const h = rng.range(preset.dropHeight[0], preset.dropHeight[1]);
    let notchX = c;
    let notchW = 0;
    if (rng.next() < preset.notchChance) {
      notchW = rng.range(7, 12);
      notchX = c + rng.range(-(w - notchW), w - notchW) * 0.7;
    }
    course.drops.push({ y, h, notchX, notchW });
  }

  const nearDrop = (y: number, margin: number) => course.drops.some((d) => y > d.y - margin && y < d.y + margin);

  const stoneN = rng.int(preset.stoneCount[0], preset.stoneCount[1]);
  let tries = 0;
  while (course.stones.length < stoneN && tries++ < 600) {
    const r = rng.range(preset.stoneRadius[0], preset.stoneRadius[1]);
    const y = rng.range(startY + 90, goalY - 40);
    if (nearDrop(y, 40 + r)) continue;
    const w = halfWidthAt(course, y);
    const c = centerAt(course, y);
    const x = c + rng.range(-w + r * 0.5, w - r * 0.5);
    let bias = rng.range(0.3, 0.6) * (rng.next() < 0.5 ? -1 : 1);
    // 隙間は「葉が通れる幅」か「岸に埋まって通れない」のどちらかにする（中途半端な挟まりを作らない）
    const gapL = x - r - (c - w);
    const gapR = c + w - (x + r);
    const okSide = (g: number) => g >= 11 || g <= 0;
    if (!okSide(gapL) || !okSide(gapR) || Math.max(gapL, gapR) < 13) continue;
    // 岸に埋まった側へは逃がさない（正面に張り付いたまま動けなくなるのを防ぐ）
    if (gapL <= 0) bias = rng.range(0.5, 0.8);
    else if (gapR <= 0) bias = -rng.range(0.5, 0.8);
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
  tries = 0;
  while (course.eddies.length < eddyN && tries++ < 100) {
    const y = rng.range(startY + 70, goalY - 30);
    if (nearDrop(y, 30)) continue;
    const w = halfWidthAt(course, y);
    const r = rng.range(6, 12);
    const x = centerAt(course, y) + rng.range(-w * 0.6, w * 0.6);
    const sp = rng.range(0.25, 0.5) * preset.baseSpeed * (rng.next() < 0.5 ? -1 : 1);
    course.eddies.push({ x, y, r, s: sp });
  }
  course.eddies.sort((a, b) => a.y - b.y);

  // 側溝のふた（見た目だけ）
  for (let i = 0; i < preset.coverCount; i++) {
    for (let k = 0; k < 20; k++) {
      const len = rng.range(50, 90);
      const y0 = rng.range(startY + 60, goalY - 40 - len);
      if (nearDrop(y0, 30) || nearDrop(y0 + len, 30) || course.drops.some((d) => d.y > y0 && d.y < y0 + len)) continue;
      if (course.covers.some((c) => y0 < c.y1 + 40 && y0 + len > c.y0 - 40)) continue;
      course.covers.push({ y0, y1: y0 + len });
      break;
    }
  }
  course.covers.sort((a, b) => a.y0 - b.y0);
  return course;
}

/** smoothstep 補間した値と、その y 微分 */
function interp(arr: number[], step: number, y: number): [number, number] {
  const f = y / step;
  const i = Math.floor(f);
  if (i < 0) return [arr[0], 0];
  if (i >= arr.length - 1) return [arr[arr.length - 1], 0];
  const t = f - i;
  const a = arr[i];
  const d = arr[i + 1] - a;
  return [a + d * t * t * (3 - 2 * t), (d * 6 * t * (1 - t)) / step];
}

export function centerAt(c: Course, y: number): number {
  return interp(c.centers, c.widthStep, y)[0];
}

export function halfWidthAt(c: Course, y: number): number {
  return interp(c.halfWidths, c.widthStep, y)[0];
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
/** 滝の上流で影響が出始める距離・下流で乱れが続く距離（cm） */
export const DROP_APPROACH = 25;
export const DROP_PLUNGE = 45;

/**
 * 流速場。out[0]=vx, out[1]=vy に書き込む。
 * ベース流（岸付近で減速・狭いところで加速）＋石まわりのポテンシャル流と後流＋渦＋流れに乗るノイズ。
 */
export function flowAt(c: Course, f: FeatureSet, x: number, y: number, t: number, out: [number, number]): void {
  const w = halfWidthAt(c, y);
  const [cx, slope] = interp(c.centers, c.widthStep, y);
  const u0 = c.flowRate / w;
  let d = (x - cx) / w;
  if (d < 0) d = -d;
  let prof: number;
  if (d >= 1) prof = 0.35;
  else {
    const d2 = d * d;
    prof = 1 - 0.65 * d2 * d2 * d2;
  }
  let vy = u0 * prof;
  // 蛇行に沿って流れる
  let vx = vy * slope;
  let turb = 1;

  // 小さな滝：上流で加速して切り欠きへ寄せられ、落ちた先は勢いよく乱れる
  for (const dr of c.drops) {
    const u = y - dr.y;
    if (u <= -DROP_APPROACH || u >= DROP_PLUNGE) continue;
    const hk = dr.h / 5;
    if (u < 0) {
      const s = smooth((u + DROP_APPROACH) / DROP_APPROACH);
      vy *= 1 + 0.5 * hk * s;
      if (dr.notchW > 0) vx += (dr.notchX - x) * 0.9 * hk * s;
    } else {
      const k = 1 - u / DROP_PLUNGE;
      vy *= 1 + 0.7 * hk * k * k;
      turb += 5 * hk * k;
      // 切り欠きから噴き出した流れが左右に広がる
      if (dr.notchW > 0) vx += (x - dr.notchX) * 0.35 * hk * k;
    }
  }

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
  const amp = c.noiseAmp * u0 * turb;
  vx += amp * valueNoise(c.noiseSeedA, nx, ny);
  vy += amp * 0.6 * valueNoise(c.noiseSeedB, nx, ny);

  out[0] = vx;
  out[1] = vy;
}
