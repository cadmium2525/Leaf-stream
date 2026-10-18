import { describe, expect, test } from 'vitest';
import { applyChallengerResult, applyDefenderResult, emptyStats, isoWeekKey } from '../../packages/sim-core/src/index.ts';

const W = '2026-W42';

describe('連勝ルール', () => {
  test('挑戦側の勝ちで +1、best を更新', () => {
    let s = emptyStats(W);
    s = applyChallengerResult(s, 'challenger_win', W);
    s = applyChallengerResult(s, 'challenger_win', W);
    expect(s.current_streak).toBe(2);
    expect(s.best_streak).toBe(2);
    expect(s.weekly_best_streak).toBe(2);
  });

  test('挑戦側の負けで 0、best は維持', () => {
    let s = { ...emptyStats(W), current_streak: 4, best_streak: 4, weekly_best_streak: 4 };
    s = applyChallengerResult(s, 'defender_win', W);
    expect(s.current_streak).toBe(0);
    expect(s.best_streak).toBe(4);
    expect(s.challenger_losses).toBe(1);
  });

  test('引き分けは維持', () => {
    const s = applyChallengerResult({ ...emptyStats(W), current_streak: 3, best_streak: 3 }, 'draw', W);
    expect(s.current_streak).toBe(3);
    expect(s.draws).toBe(1);
  });

  test('T05: 防衛側の敗北は防衛敗北 +1、現在連勝は不変', () => {
    const before = { ...emptyStats(W), current_streak: 7, best_streak: 9 };
    const after = applyDefenderResult(before, 'challenger_win');
    expect(after.defense_losses).toBe(1);
    expect(after.current_streak).toBe(7);
    expect(after.best_streak).toBe(9);
    expect(applyDefenderResult(before, 'defender_win').defense_wins).toBe(1);
  });

  test('週が変わると週間最高はリセット', () => {
    const s = applyChallengerResult({ ...emptyStats('2026-W41'), current_streak: 5, weekly_best_streak: 5 }, 'challenger_win', W);
    expect(s.weekly_best_streak).toBe(6);
    const t = applyChallengerResult({ ...emptyStats('2026-W41'), current_streak: 0, weekly_best_streak: 5 }, 'draw', W);
    expect(t.weekly_best_streak).toBe(0);
  });

  test('ISO 週キー', () => {
    expect(isoWeekKey(Date.UTC(2026, 9, 18))).toBe('2026-W42');
    expect(isoWeekKey(Date.UTC(2021, 0, 3))).toBe('2020-W53');
    expect(isoWeekKey(Date.UTC(2024, 11, 30))).toBe('2025-W01');
  });
});
