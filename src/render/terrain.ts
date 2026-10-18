/**
 * コースの地形（見た目だけ）：落差による高さ、蛇行、壁・土手・道路のジオメトリ。
 * 勝敗は sim-core の 2D 流速場だけで決まり、ここでの高さは関係しない。
 */
import * as THREE from 'three';
import { centerAt, halfWidthAt, type Course } from '../../packages/sim-core/src/index.ts';

export const S = 0.01; // cm → m
export const DEPTH = 0.09; // 水深
export const WALL_TOP = 0.2; // 水面からの壁の高さ
export const WALL_T = 0.08; // 壁の厚み
/** 落ち口から水が落ちきるまでの水平距離（cm） */
export const LIP = 7;
/** 落ち口の手前で水面が下がり始める距離（cm） */
const DRAW = 16;

const smooth = (t: number) => t * t * (3 - 2 * t);

/** 描画用の再現可能な乱数 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 座標からの決定論的なゆらぎ [-1, 1] */
function hash2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h / 4294967295) * 2 - 1;
}

export class Terrain {
  /** 描画する範囲（cm） */
  readonly y0 = -260;
  readonly y1: number;
  readonly ys: number[];

  constructor(readonly course: Course) {
    this.y1 = course.length + 420;
    // 10cm 刻み＋滝のまわりは細かく
    const set = new Set<number>();
    for (let y = this.y0; y <= this.y1; y += 10) set.add(y);
    for (const d of course.drops) {
      for (let u = -DRAW; u <= 0; u += 2) set.add(d.y + u);
      set.add(d.y + 0.4);
      for (let u = 1; u <= LIP; u += 1) set.add(d.y + u);
      for (let u = LIP + 3; u <= 40; u += 4) set.add(d.y + u);
    }
    this.ys = [...set].sort((a, b) => a - b);
  }

  private clampY(y: number): number {
    return Math.min(Math.max(y, 0), this.course.length);
  }

  /** 半幅（m） */
  hw(y: number): number {
    return halfWidthAt(this.course, this.clampY(y)) * S;
  }

  /** 中心線の x（m） */
  cx(y: number): number {
    return centerAt(this.course, this.clampY(y)) * S;
  }

  /** 水面の高さ（m）。落ち口の手前で少し下がり、その先は放物線で落ちる */
  water(y: number): number {
    let e = 0;
    for (const d of this.course.drops) {
      const u = y - d.y;
      let f: number;
      if (u <= -DRAW) f = 0;
      else if (u <= 0) f = 0.15 * smooth((u + DRAW) / DRAW);
      else if (u < LIP) {
        const t = u / LIP;
        f = 0.15 + 0.85 * t * t;
      } else f = 1;
      e -= d.h * S * f;
    }
    return e;
  }

  /** 水底・壁・土手の高さ（m）。落ち口で段になる */
  bed(y: number): number {
    let e = 0;
    for (const d of this.course.drops) {
      const u = y - d.y;
      const f = u <= 0 ? 0 : u >= 0.4 ? 1 : u / 0.4;
      e -= d.h * S * f;
    }
    return e;
  }

  /** 水面の傾き（m/m、下流向きに下がると負） */
  waterSlope(y: number): number {
    const dy = 0.8;
    return (this.water(y + dy) - this.water(y - dy)) / (2 * dy * S);
  }

  /** 流れに沿った帯（水底・水面）。edgeAttr で岸までの距離を頂点属性に入れる */
  ribbon(height: (y: number) => number, cols: number, tile: number, widen: number, edgeAttr = false): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const edge: number[] = [];
    const idx: number[] = [];
    const ys = this.ys;
    for (let i = 0; i < ys.length; i++) {
      const w = this.hw(ys[i]) + widen;
      const c = this.cx(ys[i]);
      const z = -ys[i] * S;
      const hgt = height(ys[i]);
      for (let k = 0; k < cols; k++) {
        const t = k / (cols - 1);
        const x = c - w + 2 * w * t;
        pos.push(x, hgt, z);
        uv.push(x / tile, z / tile);
        edge.push(w - Math.abs(x - c));
      }
    }
    for (let i = 0; i + 1 < ys.length; i++) {
      for (let k = 0; k + 1 < cols; k++) {
        const a = i * cols + k;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
    }
    return finish(pos, uv, idx, edgeAttr ? edge : null);
  }

  /**
   * 片側の帯状ジオメトリ（壁・土手・道路）。prof は岸からの [外向き距離 m, 高さ m, v 座標]。
   * jitter を与えると自然な凸凹になる。
   */
  strip(side: number, prof: [number, number, number][], opts: {
    tile?: number;
    colors?: number[][];
    jitter?: number;
    seed?: number;
  } = {}): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const np = prof.length;
    const ys = this.ys;
    const tile = opts.tile ?? 0.6;
    for (let i = 0; i < ys.length; i++) {
      const y = ys[i];
      const w = this.hw(y);
      const c = this.cx(y);
      const z = -y * S;
      const base = this.bed(y);
      for (let k = 0; k < np; k++) {
        const [ox, oy, v] = prof[k];
        let jx = 0;
        let jy = 0;
        // 水面より上で水際から離れた点だけ凸凹させる（水路の中に土手がはみ出さないように）
        if (opts.jitter && oy > 0.03 && ox > 0.05) {
          const yi = Math.round(y);
          jx = Math.abs(hash2(yi * 3 + side, k + (opts.seed ?? 0))) * opts.jitter;
          jy = hash2(yi * 5 - side, k * 7 + (opts.seed ?? 0)) * opts.jitter * 0.6;
        }
        pos.push(c + side * (w + ox + jx), oy + jy + base, z);
        uv.push(z / tile, v / tile);
        if (opts.colors) col.push(...opts.colors[k]);
      }
    }
    for (let i = 0; i + 1 < ys.length; i++) {
      for (let k = 0; k + 1 < np; k++) {
        const a = i * np + k;
        const b = a + 1;
        const d = a + np;
        const e = d + 1;
        if (side < 0) idx.push(a, d, b, b, d, e);
        else idx.push(a, b, d, b, e, d);
      }
    }
    const geo = finish(pos, uv, idx, null);
    if (opts.colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return geo;
  }
}

function finish(pos: number[], uv: number[], idx: number[], edge: number[] | null): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (edge) geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** コンクリート水路・側溝の壁（内面→天端→外面）の断面 */
export const WALL_PROFILE: [number, number, number][] = [
  [0, -DEPTH - 0.01, 0],
  [0, -0.012, 0.09],
  [0, 0.004, 0.11],
  [0, 0.05, 0.16],
  [0, WALL_TOP, 0.3],
  [WALL_T, WALL_TOP, 0.38],
  [WALL_T, WALL_TOP - 0.02, 0.4],
];
export const WALL_COLORS = [
  [0.42, 0.47, 0.36], [0.5, 0.55, 0.4], [0.62, 0.63, 0.52], [0.88, 0.88, 0.82], [1, 1, 1], [0.95, 0.95, 0.92], [0.8, 0.82, 0.75],
];

/** 自然の小川の土手（水中の斜面→水際→苔むした土→草地→下り斜面） */
export const NATURAL_PROFILE: [number, number, number][] = [
  [-0.05, -DEPTH - 0.02, 0],
  [-0.01, -0.03, 0.08],
  [0.02, 0.006, 0.12],
  [0.08, 0.05, 0.2],
  [0.22, 0.11, 0.35],
  [0.5, 0.17, 0.6],
  [1.0, 0.2, 1.1],
  [2.0, 0.12, 2.0],
  [3.5, -0.15, 3.4],
  [6.0, -0.6, 5.8],
];
export const NATURAL_COLORS = [
  [0.35, 0.33, 0.27], [0.4, 0.38, 0.3], [0.45, 0.47, 0.34], [0.55, 0.62, 0.38], [0.7, 0.78, 0.45],
  [0.75, 0.85, 0.5], [0.75, 0.88, 0.52], [0.7, 0.85, 0.5], [0.62, 0.75, 0.45], [0.55, 0.65, 0.42],
];
