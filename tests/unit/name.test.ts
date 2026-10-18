import { expect, test } from 'vitest';
import { nameProblem } from '../../src/app/name-field.ts';

test('ランキング名：自由な名前を受け付け、DB と同じ制約で弾く', () => {
  for (const ok of ['笹舟名人', 'leaf_master', '🍃はっぱ🍃', 'a', '１２３４５６７８９０１２３４５６']) expect(nameProblem(ok)).toBeNull();
  expect(nameProblem('')).not.toBeNull();
  expect(nameProblem('   ')).not.toBeNull();
  expect(nameProblem('あ'.repeat(17))).not.toBeNull();
  expect(nameProblem('<script>')).not.toBeNull();
  expect(nameProblem('tab\there')).not.toBeNull();
});
