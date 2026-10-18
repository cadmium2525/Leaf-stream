/**
 * シード付き疑似乱数（mulberry32）。32bit 整数演算のみで構成し、
 * どの JS エンジンでも同じ系列を返す。
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** 0 以上 2^32 未満の整数 */
  nextU32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** [0, 1) の実数（2^32 で割るだけなので決定論的） */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return min + (this.nextU32() % (maxInclusive - min + 1));
  }
}

/** 文字列・数値から 32bit シードを派生させる（FNV-1a） */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 格子点の決定論的ハッシュ値を [-1, 1] で返す（流速場のノイズ用） */
export function latticeNoise(seed: number, ix: number, iy: number): number {
  let h = (seed ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 2147483647.5 - 1;
}
