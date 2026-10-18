import { expect, test } from 'vitest';
import { simplifyPath } from '../../src/editor/editor.ts';

test('ハサミの軌跡の簡略化：直線はまとめ、角は残す', () => {
  const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [i * 0.1, 0]);
  expect(simplifyPath(line, 0.01)).toEqual([[0, 0], [4.9, 0]]);
  const v: [number, number][] = [];
  for (let i = 0; i <= 20; i++) v.push([i * 0.1, 0]);
  for (let i = 1; i <= 20; i++) v.push([2 - i * 0.1, i * 0.1]);
  const s = simplifyPath(v, 0.01);
  expect(s).toHaveLength(3);
  expect(s[1]).toEqual([2, 0]);
});
