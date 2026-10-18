-- LEAF STREAM 初期スキーマ
-- 方針：クライアントは「読む」だけ。登録・対戦作成・結果確定はサーバー関数（service_role）経由。

-- ============================================================
-- テーブル
-- ============================================================

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '名無しの葉っぱ',
  status text not null default 'active' check (status in ('active', 'hidden', 'banned')),
  created_at timestamptz not null default now(),
  constraint display_name_length check (char_length(display_name) between 1 and 16)
);

create table public.leaves (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  polygon_json jsonb not null,
  shape_hash text not null,
  active boolean not null default true,
  -- 相手抽選用のランダムキー（ORDER BY random() の全件ソートを避ける）
  rand_key double precision not null default random(),
  updated_at timestamptz not null default now()
);
create index leaves_rand_key_active on public.leaves (rand_key) where active;

create table public.races (
  id uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references public.profiles (user_id) on delete cascade,
  defender_id uuid not null references public.profiles (user_id) on delete cascade,
  challenger_leaf_version integer not null,
  defender_leaf_version integer not null,
  challenger_shape jsonb not null,
  defender_shape jsonb not null,
  course_id text not null,
  seed bigint not null check (seed >= 0 and seed < 4294967296),
  sim_version text not null,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'expired', 'failed')),
  result text check (result in ('challenger_win', 'defender_win', 'draw')),
  time_a integer,
  time_b integer,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  idempotency_key text not null unique,
  constraint resolved_has_result check (status <> 'resolved' or (result is not null and time_a is not null and time_b is not null))
);
-- 1 ユーザーにつき未確定のランク戦は 1 件まで
create unique index races_one_pending_per_challenger on public.races (challenger_id) where status = 'pending';
create index races_challenger_created on public.races (challenger_id, created_at desc);
create index races_defender_created on public.races (defender_id, created_at desc);
create index races_created on public.races (created_at);

create table public.stats (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  current_streak integer not null default 0,
  best_streak integer not null default 0,
  weekly_best_streak integer not null default 0,
  week_key text not null default '',
  defense_wins integer not null default 0,
  defense_losses integer not null default 0,
  challenger_wins integer not null default 0,
  challenger_losses integer not null default 0,
  draws integer not null default 0,
  updated_at timestamptz not null default now()
);
create index stats_best on public.stats (best_streak desc);
create index stats_current on public.stats (current_streak desc);

create table public.race_events (
  id bigint generated always as identity primary key,
  race_id uuid not null references public.races (id) on delete cascade,
  event_type text not null,
  created_at timestamptz not null default now()
);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles (user_id) on delete cascade,
  target_user_id uuid not null references public.profiles (user_id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_user_id)
);

create table public.ng_words (
  word text primary key
);
insert into public.ng_words (word) values ('死ね'), ('殺す'), ('fuck'), ('shit'), ('admin'), ('運営');

-- 運用フラグ（無料枠ガードレール）。行は 1 つだけ
create table public.service_flags (
  id integer primary key default 1 check (id = 1),
  ranked_enabled boolean not null default true,
  -- 月間のランク戦作成数の上限（Edge Function 呼出数・DB 容量の無料枠から逆算）
  monthly_race_limit integer not null default 100000,
  -- 1 ユーザーの 1 分あたり挑戦数の上限
  per_minute_limit integer not null default 6,
  updated_at timestamptz not null default now()
);
insert into public.service_flags (id) values (1);

-- ============================================================
-- 表示名の NG ワード検査
-- ============================================================

create or replace function public.check_display_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.display_name := btrim(new.display_name);
  if new.display_name ~ '[<>\u0000-\u001f]' then
    raise exception 'invalid_display_name' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.ng_words w where position(lower(w.word) in lower(new.display_name)) > 0) then
    raise exception 'ng_display_name' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger profiles_check_name before insert or update of display_name on public.profiles
for each row execute function public.check_display_name();

-- サインアップ時にプロフィールと戦績を作る
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  insert into public.stats (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ============================================================
-- RLS と権限
-- ============================================================

alter table public.profiles enable row level security;
alter table public.leaves enable row level security;
alter table public.races enable row level security;
alter table public.stats enable row level security;
alter table public.race_events enable row level security;
alter table public.reports enable row level security;
alter table public.ng_words enable row level security;
alter table public.service_flags enable row level security;

revoke all on all tables in schema public from anon, authenticated;

-- profiles：公開表示名は誰でも読める。本人は表示名だけ更新できる
grant select (user_id, display_name, status, created_at) on public.profiles to anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy profiles_read on public.profiles for select using (status = 'active' or user_id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- leaves：公開中の形状とバージョンは読める。書き込みはサーバー関数のみ
grant select (user_id, version, polygon_json, shape_hash, active, updated_at) on public.leaves to anon, authenticated;
create policy leaves_read on public.leaves for select using (
  user_id = auth.uid()
  or (active and exists (select 1 from public.profiles p where p.user_id = leaves.user_id and p.status = 'active'))
);

-- races：当事者のみ閲覧。書き込みはサーバー関数のみ
grant select on public.races to authenticated;
create policy races_read_own on public.races for select to authenticated
  using (auth.uid() = challenger_id or auth.uid() = defender_id);

-- stats：ランキング用カラムを読める。クライアントからの更新は不可
grant select (user_id, current_streak, best_streak, weekly_best_streak, week_key, defense_wins, defense_losses,
  challenger_wins, challenger_losses, draws, updated_at) on public.stats to anon, authenticated;
create policy stats_read on public.stats for select using (true);

-- reports：本人名義の通報だけ作れる（読めない）
grant insert (reporter_id, target_user_id, reason) on public.reports to authenticated;
create policy reports_insert_own on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and target_user_id <> auth.uid());

-- service_flags：受付状況だけ公開
grant select (ranked_enabled) on public.service_flags to anon, authenticated;
create policy flags_read on public.service_flags for select using (true);

-- ============================================================
-- サーバー関数（service_role 専用）
-- ============================================================

-- 葉っぱの登録：1 ユーザー 1 枚を UPSERT し version++
create or replace function public.register_leaf(p_user uuid, p_polygon jsonb, p_hash text)
returns public.leaves
language plpgsql security definer set search_path = public as $$
declare
  r public.leaves;
begin
  if not exists (select 1 from public.profiles where user_id = p_user and status <> 'banned') then
    raise exception 'profile_unavailable';
  end if;
  insert into public.leaves as l (user_id, version, polygon_json, shape_hash, active, rand_key, updated_at)
  values (p_user, 1, p_polygon, p_hash, true, random(), now())
  on conflict (user_id) do update
    set version = l.version + 1,
        polygon_json = excluded.polygon_json,
        shape_hash = excluded.shape_hash,
        active = true,
        updated_at = now()
  returning * into r;
  return r;
end $$;

-- 相手のランダム抽選（自分・非公開・停止中を除外）
create or replace function public.pick_opponent(p_user uuid)
returns public.leaves
language plpgsql security definer set search_path = public as $$
declare
  k double precision := random();
  r public.leaves;
begin
  select l.* into r from public.leaves l join public.profiles p on p.user_id = l.user_id
   where l.active and p.status = 'active' and l.user_id <> p_user and l.rand_key >= k
   order by l.rand_key limit 1;
  if r.user_id is null then
    select l.* into r from public.leaves l join public.profiles p on p.user_id = l.user_id
     where l.active and p.status = 'active' and l.user_id <> p_user and l.rand_key < k
     order by l.rand_key limit 1;
  end if;
  return r;
end $$;

-- 挑戦の作成：両者の形状・バージョン・コース・seed・sim_version を不変スナップショットとして保存
-- 戻り値が null のとき相手がいない（クライアントは練習ボットへ切替）
create or replace function public.create_challenge(
  p_user uuid, p_idem text, p_course text, p_seed bigint, p_sim_version text
) returns public.races
language plpgsql security definer set search_path = public as $$
declare
  f public.service_flags;
  existing public.races;
  mine public.leaves;
  opp public.leaves;
  r public.races;
  n integer;
begin
  select * into existing from public.races where idempotency_key = p_idem;
  if existing.id is not null then
    if existing.challenger_id <> p_user then
      raise exception 'idempotency_conflict';
    end if;
    return existing;
  end if;

  select * into f from public.service_flags where id = 1;
  if not f.ranked_enabled then
    raise exception 'ranked_paused';
  end if;
  select count(*) into n from public.races where created_at >= date_trunc('month', now());
  if n >= f.monthly_race_limit then
    raise exception 'ranked_paused';
  end if;
  select count(*) into n from public.races where challenger_id = p_user and created_at > now() - interval '1 minute';
  if n >= f.per_minute_limit then
    raise exception 'rate_limited';
  end if;

  -- 放置された未確定戦は戦績に反映せず失効させる
  update public.races set status = 'expired'
   where challenger_id = p_user and status = 'pending' and created_at < now() - interval '10 minutes';

  select * into mine from public.leaves where user_id = p_user and active;
  if mine.user_id is null then
    raise exception 'no_leaf';
  end if;

  opp := public.pick_opponent(p_user);
  if opp.user_id is null then
    return null;
  end if;

  begin
    insert into public.races (challenger_id, defender_id, challenger_leaf_version, defender_leaf_version,
      challenger_shape, defender_shape, course_id, seed, sim_version, idempotency_key)
    values (p_user, opp.user_id, mine.version, opp.version, mine.polygon_json, opp.polygon_json,
      p_course, p_seed, p_sim_version, p_idem)
    returning * into r;
  exception when unique_violation then
    -- 同じ冪等キーの同時送信なら既存を返す。そうでなければ未確定戦が残っている
    select * into existing from public.races where idempotency_key = p_idem;
    if existing.id is not null and existing.challenger_id = p_user then
      return existing;
    end if;
    raise exception 'pending_exists';
  end;
  insert into public.race_events (race_id, event_type) values (r.id, 'created');
  return r;
end $$;

-- 結果の確定：未確定→確定と stats 更新を単一トランザクションで行う。確定済みなら同じ結果を返す（冪等）
create or replace function public.resolve_race(
  p_race uuid, p_result text, p_time_a integer, p_time_b integer, p_sim_version text, p_week text
) returns public.races
language plpgsql security definer set search_path = public as $$
declare
  r public.races;
  cur integer;
begin
  select * into r from public.races where id = p_race for update;
  if r.id is null then
    raise exception 'race_not_found';
  end if;
  if r.status = 'resolved' then
    return r;
  end if;
  if r.status <> 'pending' then
    raise exception 'race_not_pending';
  end if;
  if r.sim_version <> p_sim_version then
    raise exception 'sim_version_mismatch';
  end if;
  if p_result not in ('challenger_win', 'defender_win', 'draw') then
    raise exception 'bad_result';
  end if;

  update public.races
     set status = 'resolved', result = p_result, time_a = p_time_a, time_b = p_time_b, resolved_at = now()
   where id = p_race
  returning * into r;

  insert into public.stats (user_id) values (r.challenger_id), (r.defender_id) on conflict do nothing;

  -- 挑戦側：勝ち +1 / 負け 0 / 引き分け維持。週が変わったら週間最高をリセット
  update public.stats s set
    week_key = p_week,
    weekly_best_streak = case when s.week_key = p_week then s.weekly_best_streak else 0 end,
    current_streak = case p_result when 'challenger_win' then s.current_streak + 1
                                   when 'defender_win' then 0 else s.current_streak end,
    challenger_wins = s.challenger_wins + (p_result = 'challenger_win')::int,
    challenger_losses = s.challenger_losses + (p_result = 'defender_win')::int,
    draws = s.draws + (p_result = 'draw')::int,
    updated_at = now()
  where s.user_id = r.challenger_id
  returning current_streak into cur;

  update public.stats s set
    best_streak = greatest(s.best_streak, cur),
    weekly_best_streak = greatest(s.weekly_best_streak, cur)
  where s.user_id = r.challenger_id;

  -- 防衛側：防衛記録のみ。連勝は変えない
  update public.stats s set
    defense_wins = s.defense_wins + (p_result = 'defender_win')::int,
    defense_losses = s.defense_losses + (p_result = 'challenger_win')::int,
    updated_at = now()
  where s.user_id = r.defender_id;

  insert into public.race_events (race_id, event_type) values (r.id, 'resolved');
  return r;
end $$;

-- 確定処理に失敗した場合：戦績に反映せず、再挑戦できるようにする
create or replace function public.fail_race(p_race uuid) returns void
language sql security definer set search_path = public as $$
  update public.races set status = 'failed' where id = p_race and status = 'pending';
  insert into public.race_events (race_id, event_type) select p_race, 'failed' where exists (select 1 from public.races where id = p_race);
$$;

-- ============================================================
-- 公開関数
-- ============================================================

-- ランキング（ページネーション、取得上限あり）
create or replace function public.get_leaderboard(p_sort text default 'best', p_limit integer default 20, p_offset integer default 0)
returns table (rank bigint, user_id uuid, display_name text, current_streak integer, best_streak integer,
  weekly_best_streak integer, defense_wins integer, defense_losses integer)
language plpgsql stable security definer set search_path = public as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  off integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  wk text := to_char(now() at time zone 'utc', 'IYYY-"W"IW');
begin
  return query
  select row_number() over (order by
           case p_sort when 'current' then s.current_streak
                       when 'weekly' then case when s.week_key = wk then s.weekly_best_streak else 0 end
                       else s.best_streak end desc,
           s.best_streak desc, s.updated_at asc) as rank,
         s.user_id, p.display_name, s.current_streak, s.best_streak,
         case when s.week_key = wk then s.weekly_best_streak else 0 end,
         s.defense_wins, s.defense_losses
    from public.stats s join public.profiles p on p.user_id = s.user_id
   where p.status = 'active'
     and (s.challenger_wins + s.challenger_losses + s.draws + s.defense_wins + s.defense_losses) > 0
   order by 1
   limit lim offset off;
end $$;

revoke all on function public.register_leaf(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.pick_opponent(uuid) from public, anon, authenticated;
revoke all on function public.create_challenge(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.resolve_race(uuid, text, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.fail_race(uuid) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.check_display_name() from public, anon, authenticated;
grant execute on function public.register_leaf(uuid, jsonb, text) to service_role;
grant execute on function public.pick_opponent(uuid) to service_role;
grant execute on function public.create_challenge(uuid, text, text, bigint, text) to service_role;
grant execute on function public.resolve_race(uuid, text, integer, integer, text, text) to service_role;
grant execute on function public.fail_race(uuid) to service_role;
revoke all on function public.get_leaderboard(text, integer, integer) from public;
grant execute on function public.get_leaderboard(text, integer, integer) to anon, authenticated, service_role;
