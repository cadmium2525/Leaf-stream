// POST /race-resolve { raceId } — サーバーだけで公式計算し、原子トランザクションで戦績を更新
// クライアントのタイム・勝敗値は一切受け取らない。確定済みなら同じ結果を返す（冪等）。
import { SIM_VERSION, isoWeekKey, simulateRace, type Polygon } from '../_shared/sim-core/index.ts';
import { HttpError, adminClient, dbError, handler, json, readJson, requireUser } from '../_shared/http.ts';

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);
  const body = await readJson(req);
  const raceId = body.raceId;
  if (typeof raceId !== 'string' || !/^[0-9a-f-]{36}$/.test(raceId)) throw new HttpError(400, 'bad_race_id');

  const { data: race, error } = await admin.from('races').select('*').eq('id', raceId).maybeSingle();
  if (error) throw dbError(error.message);
  if (!race || race.challenger_id !== user.id) throw new HttpError(404, 'race_not_found');

  if (race.status === 'resolved') return json({ race: publicRace(race) });
  if (race.status !== 'pending') throw new HttpError(409, 'race_not_pending');
  if (race.sim_version !== SIM_VERSION) {
    await admin.rpc('fail_race', { p_race: raceId });
    throw new HttpError(409, 'sim_version_mismatch');
  }

  let result;
  try {
    result = simulateRace({
      courseId: race.course_id,
      seed: Number(race.seed),
      challenger: race.challenger_shape as Polygon,
      defender: race.defender_shape as Polygon,
    }).result;
  } catch (e) {
    console.error('simulation failed', e);
    await admin.rpc('fail_race', { p_race: raceId });
    throw new HttpError(500, 'simulation_failed');
  }

  const { data: resolved, error: e2 } = await admin.rpc('resolve_race', {
    p_race: raceId,
    p_result: result.outcome,
    p_time_a: result.timeA,
    p_time_b: result.timeB,
    p_sim_version: SIM_VERSION,
    p_week: isoWeekKey(Date.now()),
  });
  if (e2) throw dbError(e2.message);

  const { data: stats } = await admin.from('stats').select('current_streak,best_streak').eq('user_id', user.id).single();
  return json({ race: publicRace(resolved), stats });
}));

function publicRace(r: Record<string, unknown>) {
  return {
    id: r.id,
    status: r.status,
    result: r.result,
    time_a: r.time_a,
    time_b: r.time_b,
    course_id: r.course_id,
    seed: Number(r.seed),
    sim_version: r.sim_version,
  };
}
