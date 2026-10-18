// POST /account-delete { confirm: "DELETE" } — 本人のアカウントと関連データ（葉・戦績・レース）を削除
import { HttpError, adminClient, handler, json, readJson, requireUser } from '../_shared/http.ts';

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const user = await requireUser(req, admin);
  const body = await readJson(req);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'confirm_required');
  // auth.users の削除で profiles 以下は ON DELETE CASCADE
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, 'delete_failed');
  return json({ deleted: true });
}));
