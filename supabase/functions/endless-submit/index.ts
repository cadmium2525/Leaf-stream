// POST /endless-submit { polygon, species, lane, week } — どこまでもモードの記録を、サーバーだけで再計算して登録する
// クライアントの距離は受け取らない。週キーは今週か先週（週の変わり目に流し終えた分）だけ受け付ける。
import {
  ENDLESS_VERSION, endlessSeed, isLane, isSpeciesId, isoWeekKey, normalizePolygon, shapeHash, simulateEndless, validateLeaf,
  LEAF_ERROR_MESSAGES, type Polygon,
} from '../_shared/sim-core/index.ts';
import { HttpError, adminClient, dbError, handler, json, readJson, requireUser } from '../_shared/http.ts';

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);
  const body = await readJson(req);
  const species = body.species ?? 'sakura';
  if (!isSpeciesId(species)) throw new HttpError(400, 'bad_species');
  if (!isLane(body.lane)) throw new HttpError(400, 'bad_lane');
  const now = Date.now();
  const week = typeof body.week === 'string' ? body.week : isoWeekKey(now);
  if (week !== isoWeekKey(now) && week !== isoWeekKey(now - 7 * 86400000)) throw new HttpError(400, 'bad_week');
  if (body.version !== undefined && body.version !== ENDLESS_VERSION) throw new HttpError(409, 'sim_version_mismatch');

  const v = validateLeaf(body.polygon);
  if (!v.ok) {
    return json({ error: 'invalid_leaf', reasons: v.errors, messages: v.errors.map((e) => LEAF_ERROR_MESSAGES[e]) }, 400);
  }
  const polygon = normalizePolygon(body.polygon as Polygon);
  if (JSON.stringify(polygon) !== JSON.stringify(body.polygon)) throw new HttpError(400, 'not_normalized');

  let result;
  try {
    result = simulateEndless({ seed: endlessSeed(week), polygon, lane: body.lane }).result;
  } catch (e) {
    console.error('simulation failed', e);
    throw new HttpError(500, 'simulation_failed');
  }

  const { data, error } = await admin.rpc('submit_endless', {
    p_user: user.id,
    p_week: week,
    p_distance: result.distance,
    p_polygon: polygon,
    p_hash: shapeHash(polygon),
    p_species: species,
    p_lane: body.lane,
    p_ticks: result.ticks,
    p_reason: result.reason,
    p_sim_version: ENDLESS_VERSION,
  });
  if (error) throw dbError(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return json({
    week,
    distance: result.distance,
    reason: result.reason,
    improved: row.improved,
    best: row.best,
    rank: Number(row.rank),
    sim_version: ENDLESS_VERSION,
  });
}));
