/**
 * 本番 Supabase に対するスモークテスト（SMOKE=1 のときだけ実行。通常の npm test ではスキップ）。
 * 公開 anon キーだけを使い、ゲスト 2 人で「登録 → 挑戦 → 確定 → 権限 → 削除」を通しで確かめる。
 * 実行：SMOKE=1 npx vitest run tests/smoke
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, test } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  BOT_LEAVES, ENDLESS_VERSION, endlessSeed, getSpecies, isoWeekKey, simulateEndless, simulateRace, type Polygon,
} from '../../packages/sim-core/src/index.ts';

const env = Object.fromEntries(
  readFileSync('.env.production', 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;

interface Player {
  id: string;
  sb: SupabaseClient;
  call: (fn: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
}

const players: Player[] = [];

async function newPlayer(name: string, polygon: Polygon, species = 'sakura'): Promise<Player> {
  const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error || !data.session) throw new Error(`匿名サインインに失敗：${error?.message}（Allow anonymous sign-ins は ON？）`);
  const token = data.session.access_token;
  const call = async (fn: string, body: unknown) => {
    const r = await fetch(`${URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: KEY },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const p = { id: data.user!.id, sb, call };
  players.push(p);
  const { error: e2 } = await sb.from('profiles').update({ display_name: name }).eq('user_id', p.id);
  expect(e2, 'プロフィール名の更新').toBeNull();
  const reg = await call('leaf-register', { polygon, species });
  expect(reg.status, `leaf-register: ${JSON.stringify(reg.body)}`).toBe(200);
  expect(reg.body.species).toBe(species);
  return p;
}

describe.skipIf(!process.env.SMOKE)('本番スモークテスト', () => {
  afterAll(async () => {
    // テスト用のプレイヤーを消す
    for (const p of players) await p.call('account-delete', { confirm: 'DELETE' });
  });

  test('ゲスト 2 人で登録 → ランク戦 → 確定 → 権限 → 削除', async () => {
    expect(URL).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/);

    // 公開データ（未ログイン）
    const anon = createClient(URL, KEY, { auth: { persistSession: false } });
    const flags = await anon.from('service_flags').select('ranked_enabled').single();
    expect(flags.error, JSON.stringify(flags.error)).toBeNull();
    expect(flags.data!.ranked_enabled).toBe(true);
    const lb = await anon.rpc('get_leaderboard', { p_sort: 'best', p_limit: 5, p_offset: 0 });
    expect(lb.error, JSON.stringify(lb.error)).toBeNull();

    const a = await newPlayer('スモークA', getSpecies('momiji').polygon, 'momiji');
    await newPlayer('スモークB', BOT_LEAVES.find((b) => b.id === 'bot-slim')!.polygon);

    // 名前が付いている
    const prof = await a.sb.from('profiles').select('display_name').eq('user_id', a.id).single();
    expect(prof.data?.display_name).toBe('スモークA');

    // 不正な形は登録拒否（T01）
    const bad = await a.call('leaf-register', { polygon: [[-2, -3], [2, 3], [2, -3], [-2, 3]] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_leaf');

    // 挑戦 → 相手が決まり、スナップショットが返る
    const ch = await a.call('race-challenge', { idempotencyKey: crypto.randomUUID() });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    const race = ch.body.race as { id: string; course_id: string; seed: number; challenger_shape: Polygon; defender_shape: Polygon; challenger_species: string };
    expect(race, '相手が見つからない').toBeTruthy();
    expect(race.challenger_species).toBe('momiji');

    // サーバー確定
    const r1 = await a.call('race-resolve', { raceId: race.id });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const official = r1.body.race as { result: string; time_a: number; time_b: number; status: string };
    expect(official.status).toBe('resolved');

    // サーバー（Deno）とブラウザ側の計算が一致する
    const local = simulateRace({ courseId: race.course_id, seed: race.seed, challenger: race.challenger_shape, defender: race.defender_shape }).result;
    expect({ result: official.result, a: official.time_a, b: official.time_b }).toEqual({ result: local.outcome, a: local.timeA, b: local.timeB });

    // 再送しても同じ結果（冪等）
    const r2 = await a.call('race-resolve', { raceId: race.id });
    expect((r2.body.race as { result: string }).result).toBe(official.result);

    // 戦績は 1 回分だけ
    const st = await a.sb.from('stats').select('current_streak,challenger_wins,challenger_losses,draws').eq('user_id', a.id).single();
    expect(st.data!.challenger_wins + st.data!.challenger_losses + st.data!.draws).toBe(1);
    expect(st.data!.current_streak).toBe(official.result === 'challenger_win' ? 1 : 0);

    // クライアントからの直接書き換えは拒否（T07）
    const hack = await a.sb.from('stats').update({ current_streak: 999 }).eq('user_id', a.id);
    expect(hack.error).not.toBeNull();
    const hack2 = await a.sb.from('races').insert({ challenger_id: a.id });
    expect(hack2.error).not.toBeNull();

    // 自分のレースは見える
    const mine = await a.sb.from('races').select('id').eq('id', race.id);
    expect(mine.data).toHaveLength(1);
  }, 60_000);

  test('どこまでも：サーバーの再計算で記録 → 自己ベストだけ更新 → ランキング', async () => {
    const p = await newPlayer('スモークE', getSpecies('sakura').polygon);
    const week = isoWeekKey(Date.now());
    const polygon = getSpecies('nasturtium').polygon;
    const local = simulateEndless({ seed: endlessSeed(week), polygon, lane: 2 }).result;

    const r1 = await p.call('endless-submit', { polygon, species: 'nasturtium', lane: 2, week, version: ENDLESS_VERSION });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    // サーバー（Deno）とブラウザ側の計算が一致する
    expect(r1.body.distance).toBe(local.distance);
    expect(r1.body.improved).toBe(true);
    expect(r1.body.best).toBe(local.distance);

    // 小さすぎる記録では自己ベストは変わらない
    const tiny = simulateEndless({ seed: endlessSeed(week), polygon: getSpecies('yanagi').polygon, lane: -10 }).result;
    const r2 = await p.call('endless-submit', { polygon: getSpecies('yanagi').polygon, species: 'yanagi', lane: -10, week, version: ENDLESS_VERSION });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.best).toBe(Math.max(local.distance, tiny.distance));

    // 不正な入力は拒否
    expect((await p.call('endless-submit', { polygon, lane: 99, week })).body.error).toBe('bad_lane');
    expect((await p.call('endless-submit', { polygon, lane: 0, week: '1999-W01' })).body.error).toBe('bad_week');
    expect((await p.call('endless-submit', { polygon, lane: 0, week, version: 'old' })).status).toBe(409);

    // ランキングに載り、クライアントからの直接書き込みは拒否
    const anon = createClient(URL, KEY, { auth: { persistSession: false } });
    const lb = await anon.rpc('get_endless_leaderboard', { p_week: week, p_limit: 50, p_offset: 0 });
    expect(lb.error, JSON.stringify(lb.error)).toBeNull();
    expect((lb.data as { user_id: string }[]).some((r) => r.user_id === p.id)).toBe(true);
    const hack = await p.sb.from('endless_records').update({ distance_cm: 999999 }).eq('user_id', p.id);
    const after = await anon.from('endless_records').select('distance_cm').eq('user_id', p.id).eq('week_key', week).single();
    expect(hack.error !== null || after.data!.distance_cm !== 999999).toBe(true);
    expect(after.data!.distance_cm).toBe(r2.body.best);
  }, 60_000);
});
