// Edge Functions 共通：CORS・JSON 応答・認証
import { createClient, type SupabaseClient, type User } from 'jsr:@supabase/supabase-js@2';

const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** service_role のクライアント。キーはサーバー関数のシークレットにのみ存在する */
export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Authorization ヘッダーの JWT を検証して本人を返す */
export async function requireUser(req: Request, admin: SupabaseClient): Promise<User> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new HttpError(401, 'unauthorized');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'unauthorized');
  return data.user;
}

export async function readJson(req: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large');
  try {
    const v = JSON.parse(text || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

/** DB 関数の例外メッセージを HTTP エラーに変換する */
const DB_ERRORS: Record<string, number> = {
  ranked_paused: 503,
  rate_limited: 429,
  pending_exists: 409,
  no_leaf: 400,
  idempotency_conflict: 409,
  race_not_found: 404,
  race_not_pending: 409,
  sim_version_mismatch: 409,
  profile_unavailable: 403,
};

export function dbError(message: string): HttpError {
  for (const [code, status] of Object.entries(DB_ERRORS)) {
    if (message.includes(code)) return new HttpError(status, code);
  }
  console.error('db error', message);
  return new HttpError(500, 'internal');
}

export function handler(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      console.error(e);
      return json({ error: 'internal' }, 500);
    }
  };
}
