// POST /race-challenge { idempotencyKey } — 相手抽選、両 shape_snapshot と seed を確定して race を作成
import { COURSE_IDS, SIM_VERSION } from '../_shared/sim-core/index.ts';
import { HttpError, adminClient, dbError, handler, json, readJson, requireUser } from '../_shared/http.ts';

function randomU32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);
  const body = await readJson(req);
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new HttpError(400, 'bad_idempotency_key');

  const courseId = COURSE_IDS[randomU32() % COURSE_IDS.length];
  const { data, error } = await admin.rpc('create_challenge', {
    p_user: user.id,
    p_idem: `${user.id}:${key}`,
    p_course: courseId,
    p_seed: randomU32(),
    p_sim_version: SIM_VERSION,
  });
  if (error) throw dbError(error.message);
  if (!data || !data.id) {
    // 相手がいない：練習ボットに切替（ランク戦の対象外）
    return json({ race: null, reason: 'no_opponent' });
  }
  const { data: opp } = await admin.from('profiles').select('display_name').eq('user_id', data.defender_id).single();
  return json({
    race: {
      id: data.id,
      course_id: data.course_id,
      seed: Number(data.seed),
      sim_version: data.sim_version,
      challenger_shape: data.challenger_shape,
      defender_shape: data.defender_shape,
      challenger_leaf_version: data.challenger_leaf_version,
      defender_leaf_version: data.defender_leaf_version,
      defender_name: opp?.display_name ?? '???',
      status: data.status,
    },
  });
}));
