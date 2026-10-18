/**
 * サーバー API クライアント。
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定ならオフライン（練習のみ）で動く。
 * ブラウザに置くのは公開 anon キーだけ。service_role キーは絶対に置かない。
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Polygon } from '../../packages/sim-core/src/index.ts';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const online = !!(url && anonKey);
export const supabase: SupabaseClient | null = online ? createClient(url!, anonKey!) : null;

export class ApiError extends Error {
  constructor(public code: string, public status = 0, public details?: unknown) {
    super(code);
  }
}

const ERROR_TEXT: Record<string, string> = {
  offline: 'サーバーが設定されていません（練習モードのみ）',
  unauthorized: 'サインインが必要です',
  invalid_leaf: '葉っぱの形が登録条件を満たしていません',
  not_normalized: '形状データが正規化されていません',
  ranked_paused: 'ただいまランク戦の受付を停止しています（練習戦は遊べます）',
  rate_limited: '少し時間をおいてから挑戦してください',
  pending_exists: '前のレースの結果を確定中です。少し待ってから挑戦してください',
  no_leaf: '先に葉っぱを登録してください',
  race_not_found: 'レースが見つかりません',
  sim_version_mismatch: 'ゲームが更新されました。ページを再読み込みしてください',
  simulation_failed: '結果の確定に失敗しました。戦績には反映されていません',
  network: '通信に失敗しました',
  internal: 'サーバーで問題が起きました。戦績には反映されていません',
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return ERROR_TEXT[e.code] ?? `エラー：${e.code}`;
  return ERROR_TEXT.network;
}

function need(): SupabaseClient {
  if (!supabase) throw new ApiError('offline');
  return supabase;
}

async function call<T>(fn: string, body: unknown): Promise<T> {
  const sb = need();
  const { data: s } = await sb.auth.getSession();
  if (!s.session) throw new ApiError('unauthorized', 401);
  let res: Response;
  try {
    res = await fetch(`${url}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.session.access_token}`,
        apikey: anonKey!,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'internal', res.status, data);
  return data as T;
}

// ---------- 認証 ----------

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(fn: (s: Session | null) => void): void {
  supabase?.auth.onAuthStateChange((_e, s) => fn(s));
}

export async function signInWithEmail(email: string): Promise<void> {
  const { error } = await need().auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/account` } });
  if (error) throw new ApiError(error.message);
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

// ---------- プロフィール・戦績 ----------

export interface Profile {
  user_id: string;
  display_name: string;
}

export interface Stats {
  current_streak: number;
  best_streak: number;
  weekly_best_streak: number;
  defense_wins: number;
  defense_losses: number;
  challenger_wins: number;
  challenger_losses: number;
  draws: number;
}

export async function getMyProfile(): Promise<{ profile: Profile | null; stats: Stats | null; leaf: MyLeaf | null }> {
  const sb = need();
  const s = await getSession();
  if (!s) return { profile: null, stats: null, leaf: null };
  const uid = s.user.id;
  const [p, st, l] = await Promise.all([
    sb.from('profiles').select('user_id,display_name').eq('user_id', uid).maybeSingle(),
    sb.from('stats').select('current_streak,best_streak,weekly_best_streak,defense_wins,defense_losses,challenger_wins,challenger_losses,draws').eq('user_id', uid).maybeSingle(),
    sb.from('leaves').select('version,polygon_json,shape_hash,updated_at').eq('user_id', uid).maybeSingle(),
  ]);
  return {
    profile: p.data as Profile | null,
    stats: st.data as Stats | null,
    leaf: l.data ? { version: l.data.version, polygon: l.data.polygon_json as Polygon, shape_hash: l.data.shape_hash, updated_at: l.data.updated_at } : null,
  };
}

export async function updateDisplayName(name: string): Promise<void> {
  const sb = need();
  const s = await getSession();
  if (!s) throw new ApiError('unauthorized');
  const { error } = await sb.from('profiles').update({ display_name: name }).eq('user_id', s.user.id);
  if (error) throw new ApiError(error.message.includes('ng_display_name') ? 'ng_display_name' : 'invalid_display_name');
}
ERROR_TEXT.ng_display_name = 'その名前は使えません';
ERROR_TEXT.invalid_display_name = '名前は 1〜16 文字で入力してください';

// ---------- 葉っぱ ----------

export interface MyLeaf {
  version: number;
  polygon: Polygon;
  shape_hash: string;
  updated_at: string;
}

/** POST /leaf/register */
export async function registerLeaf(polygon: Polygon): Promise<{ version: number; shape_hash: string }> {
  return call('leaf-register', { polygon });
}

// ---------- 対戦 ----------

export interface RankedRace {
  id: string;
  course_id: string;
  seed: number;
  sim_version: string;
  challenger_shape: Polygon;
  defender_shape: Polygon;
  defender_name: string;
}

export interface ResolvedRace {
  race: { id: string; status: string; result: 'challenger_win' | 'defender_win' | 'draw'; time_a: number; time_b: number };
  stats?: { current_streak: number; best_streak: number };
}

/** POST /race/challenge。相手がいなければ race=null */
export async function challenge(idempotencyKey: string): Promise<{ race: RankedRace | null }> {
  return call('race-challenge', { idempotencyKey });
}

/** POST /race/{id}/resolve。同じ ID なら何度呼んでも同じ結果 */
export async function resolveRace(raceId: string): Promise<ResolvedRace> {
  return call('race-resolve', { raceId });
}

export async function reportUser(targetUserId: string, reason: string): Promise<void> {
  const sb = need();
  const s = await getSession();
  if (!s) throw new ApiError('unauthorized');
  const { error } = await sb.from('reports').insert({ reporter_id: s.user.id, target_user_id: targetUserId, reason });
  if (error && !error.message.includes('duplicate')) throw new ApiError('internal');
}

export async function getRaceDefender(raceId: string): Promise<string | null> {
  const { data } = await need().from('races').select('defender_id').eq('id', raceId).maybeSingle();
  return data?.defender_id ?? null;
}

export async function deleteAccount(): Promise<void> {
  await call('account-delete', { confirm: 'DELETE' });
  await signOut();
}

// ---------- ランキング ----------

export interface LeaderRow {
  rank: number;
  user_id: string;
  display_name: string;
  current_streak: number;
  best_streak: number;
  weekly_best_streak: number;
  defense_wins: number;
  defense_losses: number;
}

/** GET /leaderboard */
export async function leaderboard(sort: 'best' | 'current' | 'weekly', page: number, pageSize = 20): Promise<LeaderRow[]> {
  const { data, error } = await need().rpc('get_leaderboard', { p_sort: sort, p_limit: pageSize, p_offset: page * pageSize });
  if (error) throw new ApiError('internal');
  return (data ?? []) as LeaderRow[];
}

export async function rankedEnabled(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.from('service_flags').select('ranked_enabled').maybeSingle();
  return data?.ranked_enabled ?? false;
}
