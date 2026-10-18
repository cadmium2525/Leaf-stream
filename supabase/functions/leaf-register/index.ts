// POST /leaf-register { polygon, species } — 本人認証・外形の再検証・1 枚を UPSERT（version++）
import { isSpeciesId, normalizePolygon, shapeHash, validateLeaf, LEAF_ERROR_MESSAGES, type Polygon } from '../_shared/sim-core/index.ts';
import { HttpError, adminClient, dbError, handler, json, readJson, requireUser } from '../_shared/http.ts';

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);
  const body = await readJson(req);
  const polygon = body.polygon;
  // 種類は省略時サクラ。知らない値は拒否
  const species = body.species ?? 'sakura';
  if (!isSpeciesId(species)) throw new HttpError(400, 'bad_species');

  // クライアント側の検証には依存しない
  const v = validateLeaf(polygon);
  if (!v.ok) {
    return json({ error: 'invalid_leaf', reasons: v.errors, messages: v.errors.map((e) => LEAF_ERROR_MESSAGES[e]) }, 400);
  }
  // 正規化済みの形だけを受け付ける（スナップショットと再計算を一意にするため）
  const normalized = normalizePolygon(polygon as Polygon);
  if (JSON.stringify(normalized) !== JSON.stringify(polygon)) {
    throw new HttpError(400, 'not_normalized');
  }

  const { data, error } = await admin.rpc('register_leaf', {
    p_user: user.id,
    p_polygon: normalized,
    p_hash: shapeHash(normalized),
    p_species: species,
  });
  if (error) throw dbError(error.message);
  return json({ version: data.version, shape_hash: data.shape_hash, species: data.species });
}));
