// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/**
 * 戦績更新ルール（純粋関数）。DB の resolve_race() と同じ規則で、テストの基準にもする。
 * - 挑戦側 WIN：current_streak+1、best は max。LOSE：0。DRAW：維持
 * - 防衛側：defense_wins / defense_losses のみ。自身の連勝は変えない
 */
import type { RaceOutcome } from './sim.ts';

export interface PlayerStats {
  current_streak: number;
  best_streak: number;
  weekly_best_streak: number;
  /** weekly_best_streak が属する週（例 "2026-W42"） */
  week_key: string;
  defense_wins: number;
  defense_losses: number;
  challenger_wins: number;
  challenger_losses: number;
  draws: number;
}

export function emptyStats(weekKey = ''): PlayerStats {
  return {
    current_streak: 0, best_streak: 0, weekly_best_streak: 0, week_key: weekKey,
    defense_wins: 0, defense_losses: 0, challenger_wins: 0, challenger_losses: 0, draws: 0,
  };
}

export function applyChallengerResult(s: PlayerStats, outcome: RaceOutcome, weekKey: string): PlayerStats {
  const n = { ...s };
  if (n.week_key !== weekKey) {
    n.week_key = weekKey;
    n.weekly_best_streak = 0;
  }
  if (outcome === 'challenger_win') {
    n.current_streak += 1;
    n.challenger_wins += 1;
  } else if (outcome === 'defender_win') {
    n.current_streak = 0;
    n.challenger_losses += 1;
  } else {
    n.draws += 1;
  }
  n.best_streak = Math.max(n.best_streak, n.current_streak);
  n.weekly_best_streak = Math.max(n.weekly_best_streak, n.current_streak);
  return n;
}

export function applyDefenderResult(s: PlayerStats, outcome: RaceOutcome): PlayerStats {
  const n = { ...s };
  if (outcome === 'challenger_win') n.defense_losses += 1;
  else if (outcome === 'defender_win') n.defense_wins += 1;
  return n;
}

/** ISO 8601 週キー（UTC）。サーバー側で使う */
/* eslint-disable no-restricted-globals -- 暦計算のみ。シミュレーションには使わない */
export function isoWeekKey(epochMs: number): string {
  const d = new Date(epochMs);
  const day = (d.getUTCDay() + 6) % 7; // 月曜=0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / 86400000 / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
/* eslint-enable no-restricted-globals */
