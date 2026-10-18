import { expect, test } from 'vitest';
import { Rng, hashSeed, latticeNoise } from '../../packages/sim-core/src/prng.ts';

test('同じシードで同じ系列', () => {
  const a = new Rng(123);
  const b = new Rng(123);
  for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
});

test('既知の値（エンジン間の互換チェック用の固定値）', () => {
  const r = new Rng(1);
  expect([r.nextU32(), r.nextU32(), r.nextU32()]).toEqual([2693262067, 11749833, 2265367787]);
  expect(hashSeed('course', 'tanbo', 1)).toBe(hashSeed('course', 'tanbo', 1));
});

test('範囲', () => {
  const r = new Rng(9);
  for (let i = 0; i < 1000; i++) {
    const v = r.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
    const k = r.int(3, 5);
    expect(k).toBeGreaterThanOrEqual(3);
    expect(k).toBeLessThanOrEqual(5);
  }
  for (let i = -50; i < 50; i++) {
    const n = latticeNoise(5, i, i * 3);
    expect(n).toBeGreaterThanOrEqual(-1);
    expect(n).toBeLessThanOrEqual(1);
  }
});
