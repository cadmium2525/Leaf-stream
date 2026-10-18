-- DB 統合テスト（T04〜T10 のうち DB で担保する項目）
\set ON_ERROR_STOP on
\i supabase/tests/helpers.sql

-- ユーザー 3 人：a（挑戦者）、b（防衛者）、c（相手のいないケース用に後で非公開化）
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c');

select pg_temp.assert((select count(*) from profiles) = 3, 'サインアップでプロフィール作成');
select pg_temp.assert((select count(*) from stats) = 3, 'サインアップで戦績作成');

-- 葉っぱ登録（service_role）
set role service_role;
select pg_temp.assert((register_leaf('00000000-0000-0000-0000-00000000000a', '[[0,0],[1,0],[0,1]]', 'h1')).version = 1, '初回登録 version=1');
select pg_temp.assert((register_leaf('00000000-0000-0000-0000-00000000000a', '[[0,0],[2,0],[0,2]]', 'h2')).version = 2, '再登録で version++');
select pg_temp.assert((select count(*) from leaves where user_id = '00000000-0000-0000-0000-00000000000a') = 1, '1 ユーザー 1 枚');
reset role;

-- T10: 相手が 0 人なら null（クライアントは練習ボットへ）
set role service_role;
select pg_temp.assert((create_challenge('00000000-0000-0000-0000-00000000000a', 'k0', 'tanbo', 1, '1.0.0')).id is null, 'T10 相手不在で null');
select register_leaf('00000000-0000-0000-0000-00000000000b', '[[0,0],[3,0],[0,3]]', 'hb');
reset role;

-- 挑戦作成とスナップショット
set role service_role;
create temp table r1 as select * from create_challenge('00000000-0000-0000-0000-00000000000a', 'k1', 'tanbo', 42, '1.0.0');
reset role;
select pg_temp.assert((select defender_id from r1) = '00000000-0000-0000-0000-00000000000b', '自分以外が抽選される');
select pg_temp.assert((select challenger_leaf_version from r1) = 2, '挑戦側バージョンを保存');
select pg_temp.assert((select challenger_shape from r1) = '[[0,0],[2,0],[0,2]]'::jsonb, '挑戦側形状を保存');

-- 冪等：同じキーで同じレース
set role service_role;
select pg_temp.assert((create_challenge('00000000-0000-0000-0000-00000000000a', 'k1', 'tanbo', 42, '1.0.0')).id = (select id from r1), '同じ冪等キーは同じレース');
-- 未確定は 1 件まで
do $$ begin
  perform create_challenge('00000000-0000-0000-0000-00000000000a', 'k2', 'tanbo', 43, '1.0.0');
  raise exception 'should fail';
exception when others then
  if sqlerrm <> 'pending_exists' then raise; end if;
end $$;
reset role;

-- T09: レース中に葉を編集してもスナップショットは不変
set role service_role;
select register_leaf('00000000-0000-0000-0000-00000000000a', '[[0,0],[4,0],[0,4]]', 'h3');
select register_leaf('00000000-0000-0000-0000-00000000000b', '[[0,0],[5,0],[0,5]]', 'hb2');
reset role;
select pg_temp.assert((select challenger_shape from races where id = (select id from r1)) = '[[0,0],[2,0],[0,2]]'::jsonb, 'T09 挑戦側スナップショット維持');
select pg_temp.assert((select defender_shape from races where id = (select id from r1)) = '[[0,0],[3,0],[0,3]]'::jsonb, 'T09 防衛側スナップショット維持');

-- 連勝を作っておく
update stats set current_streak = 3, best_streak = 3, week_key = '2026-W42', weekly_best_streak = 3 where user_id = '00000000-0000-0000-0000-00000000000a';
update stats set current_streak = 5, best_streak = 8 where user_id = '00000000-0000-0000-0000-00000000000b';

-- 確定（挑戦側の勝ち）。2 回呼んでも 1 回分だけ（T06 の逐次版）
set role service_role;
select resolve_race((select id from r1), 'challenger_win', 2000, 2100, '1.0.0', '2026-W42');
select resolve_race((select id from r1), 'challenger_win', 2000, 2100, '1.0.0', '2026-W42');
-- 異なる値で再送されても確定済みの結果が返る
select pg_temp.assert((resolve_race((select id from r1), 'defender_win', 1, 1, '1.0.0', '2026-W42')).result = 'challenger_win', '確定済みは同じ結果を返す');
reset role;
select pg_temp.assert((select current_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 4, '挑戦側 +1 は 1 回だけ');
select pg_temp.assert((select best_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 4, 'best 更新');
select pg_temp.assert((select weekly_best_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 4, '週間 best 更新');
-- T05: 防衛側が敗北 → 防衛敗北 +1、現在連勝不変
select pg_temp.assert((select defense_losses from stats where user_id = '00000000-0000-0000-0000-00000000000b') = 1, 'T05 防衛敗北 +1');
select pg_temp.assert((select current_streak from stats where user_id = '00000000-0000-0000-0000-00000000000b') = 5, 'T05 防衛側の連勝不変');
select pg_temp.assert((select best_streak from stats where user_id = '00000000-0000-0000-0000-00000000000b') = 8, 'T05 防衛側の best 不変');
-- T04: 他人の葉で対戦しても、相手の葉は変更されない
select pg_temp.assert((select version from leaves where user_id = '00000000-0000-0000-0000-00000000000b') = 2, 'T04 相手の葉バージョンは本人の登録でのみ変化');
select pg_temp.assert((select polygon_json from leaves where user_id = '00000000-0000-0000-0000-00000000000b') = '[[0,0],[5,0],[0,5]]'::jsonb, 'T04 相手の葉は不変');

-- 挑戦側の負け → 0、引き分け → 維持
set role service_role;
create temp table r2 as select * from create_challenge('00000000-0000-0000-0000-00000000000a', 'k3', 'jutaku', 7, '1.0.0');
select resolve_race((select id from r2), 'draw', 2000, 2000, '1.0.0', '2026-W42');
reset role;
select pg_temp.assert((select current_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 4, '引き分けは維持');
set role service_role;
create temp table r3 as select * from create_challenge('00000000-0000-0000-0000-00000000000a', 'k4', 'jutaku', 8, '1.0.0');
select resolve_race((select id from r3), 'defender_win', 2200, 2000, '1.0.0', '2026-W43');
reset role;
select pg_temp.assert((select current_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 0, '負けで 0');
select pg_temp.assert((select best_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 4, 'best は維持');
select pg_temp.assert((select weekly_best_streak from stats where user_id = '00000000-0000-0000-0000-00000000000a') = 0, '週が変わると週間 best リセット');
select pg_temp.assert((select defense_wins from stats where user_id = '00000000-0000-0000-0000-00000000000b') = 1, '防衛勝利 +1');

-- sim_version 不一致は確定しない
set role service_role;
create temp table r4 as select * from create_challenge('00000000-0000-0000-0000-00000000000a', 'k5', 'tanbo', 9, '1.0.0');
do $$ begin
  perform resolve_race((select id from r4), 'draw', 1, 1, '0.9.0', '2026-W43');
  raise exception 'should fail';
exception when others then
  if sqlerrm <> 'sim_version_mismatch' then raise; end if;
end $$;
-- 確定失敗は戦績に反映せずリトライ可能（新しい挑戦を作れる）
select fail_race((select id from r4));
select pg_temp.assert((create_challenge('00000000-0000-0000-0000-00000000000a', 'k6', 'tanbo', 10, '1.0.0')).id is not null, '失敗後に再挑戦できる');
reset role;

-- T07: 本人以外（本人も）の stats 更新はクライアント権限で拒否
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  update stats set current_streak = 999 where user_id = '00000000-0000-0000-0000-00000000000b';
  raise exception 'should fail';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update stats set current_streak = 999 where user_id = '00000000-0000-0000-0000-00000000000a';
  raise exception 'should fail';
exception when insufficient_privilege then null;
end $$;
-- クライアントは葉・レースを直接書けない、サーバー関数も呼べない
do $$ begin
  update leaves set polygon_json = '[]' where user_id = '00000000-0000-0000-0000-00000000000a';
  raise exception 'should fail';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  insert into races (challenger_id, defender_id, challenger_leaf_version, defender_leaf_version, challenger_shape, defender_shape, course_id, seed, sim_version, idempotency_key)
  values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 1, 1, '[]', '[]', 'tanbo', 1, '1.0.0', 'x');
  raise exception 'should fail';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform resolve_race('00000000-0000-0000-0000-000000000000', 'draw', 1, 1, '1.0.0', 'w');
  raise exception 'should fail';
exception when insufficient_privilege then null;
end $$;
-- 表示名は本人だけ更新できる。NG ワードは拒否
update profiles set display_name = '笹舟名人' where user_id = '00000000-0000-0000-0000-00000000000a';
update profiles set display_name = '乗っ取り' where user_id = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  update profiles set display_name = '運営です' where user_id = '00000000-0000-0000-0000-00000000000a';
  raise exception 'should fail';
exception when check_violation then null;
end $$;
-- 自分が当事者のレースだけ見える
select pg_temp.assert((select count(*) from races) >= 1, '当事者のレースは見える');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select pg_temp.assert((select count(*) from races) = 0, '他人のレースは見えない');
reset role;
select pg_temp.assert((select display_name from profiles where user_id = '00000000-0000-0000-0000-00000000000a') = '笹舟名人', '本人の表示名更新');
select pg_temp.assert((select display_name from profiles where user_id = '00000000-0000-0000-0000-00000000000b') <> '乗っ取り', '他人の表示名は更新できない');

-- ランキング（anon で読める）
set role anon;
select pg_temp.assert((select count(*) from get_leaderboard('best', 10, 0)) = 2, 'ランキング取得');
select pg_temp.assert((select display_name from get_leaderboard('best', 10, 0) where rank = 1) = '名無しの葉っぱ', 'best 順');
select pg_temp.assert((select count(*) from get_leaderboard('best', 100000, 0)) <= 50, '取得上限');
reset role;

-- T08: 無料枠の閾値で新規ランク戦の受付停止
update races set status = 'resolved', result = 'draw', time_a = 1, time_b = 1 where status = 'pending';
update service_flags set monthly_race_limit = (select count(*) from races);
set role service_role;
do $$ begin
  perform create_challenge('00000000-0000-0000-0000-00000000000a', 'k9', 'tanbo', 11, '1.0.0');
  raise exception 'should fail';
exception when others then
  if sqlerrm <> 'ranked_paused' then raise; end if;
end $$;
reset role;
update service_flags set monthly_race_limit = 100000, ranked_enabled = false;
set role service_role;
do $$ begin
  perform create_challenge('00000000-0000-0000-0000-00000000000a', 'k10', 'tanbo', 12, '1.0.0');
  raise exception 'should fail';
exception when others then
  if sqlerrm <> 'ranked_paused' then raise; end if;
end $$;
reset role;
update service_flags set ranked_enabled = true;

-- 非公開ユーザーは抽選対象外
update profiles set status = 'hidden' where user_id = '00000000-0000-0000-0000-00000000000b';
set role service_role;
select pg_temp.assert((create_challenge('00000000-0000-0000-0000-00000000000a', 'k11', 'tanbo', 13, '1.0.0')).id is null, '非公開は抽選対象外');
reset role;
update profiles set status = 'active' where user_id = '00000000-0000-0000-0000-00000000000b';

-- アカウント削除で関連データも消える
delete from auth.users where id = '00000000-0000-0000-0000-00000000000c';
select pg_temp.assert((select count(*) from profiles where user_id = '00000000-0000-0000-0000-00000000000c') = 0, '削除でプロフィール消去');

select 'db_test: all passed' as result;
