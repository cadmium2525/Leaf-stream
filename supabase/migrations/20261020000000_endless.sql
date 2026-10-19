-- どこまでもモード：詰まるまで流して進んだ距離を競う。週ごとに同じコース（週キーから決まるシード）
-- 記録はサーバー関数が葉の形と流す位置から再計算した距離だけを保存する（クライアントの距離は受け取らない）

-- 週ごとの自己ベスト。どこまでもモードの葉はレース用の葉（leaves）とは別に、記録と一緒に持つ
create table public.endless_records (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  week_key text not null check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  distance_cm integer not null check (distance_cm >= 0),
  polygon_json jsonb not null,
  shape_hash text not null,
  species text not null default 'sakura' check (species in ('sakura', 'yanagi', 'nasturtium', 'momiji')),
  lane smallint not null check (lane between -10 and 10),
  ticks integer not null check (ticks >= 0),
  reason text not null,
  sim_version text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, week_key)
);
create index endless_records_week on public.endless_records (week_key, distance_cm desc, updated_at);
create index endless_records_best on public.endless_records (distance_cm desc, updated_at);

-- 送信回数の制限用（直近 1 日ぶんだけ残す）
create table public.endless_attempts (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index endless_attempts_user on public.endless_attempts (user_id, created_at);

alter table public.endless_records enable row level security;
alter table public.endless_attempts enable row level security;

-- 記録（葉の形を含む）は誰でも読める。書き込みはサーバー関数だけ
grant select (user_id, week_key, distance_cm, polygon_json, species, lane, reason, updated_at)
  on public.endless_records to anon, authenticated;
create policy endless_records_read on public.endless_records for select using (true);

grant select, insert, update, delete on public.endless_records, public.endless_attempts to service_role;

-- 記録の登録：自己ベストを更新したときだけ書き換える。今週の順位も返す
create or replace function public.submit_endless(
  p_user uuid, p_week text, p_distance integer, p_polygon jsonb, p_hash text, p_species text,
  p_lane integer, p_ticks integer, p_reason text, p_sim_version text
) returns table (improved boolean, best integer, rank bigint)
language plpgsql security definer set search_path = public as $$
declare
  prev integer;
  n integer;
begin
  if not exists (select 1 from public.profiles where user_id = p_user and status <> 'banned') then
    raise exception 'profile_unavailable';
  end if;
  if not (select ranked_enabled from public.service_flags where id = 1) then
    raise exception 'ranked_paused';
  end if;
  -- 1 時間に 120 回まで
  select count(*) into n from public.endless_attempts
   where user_id = p_user and created_at > now() - interval '1 hour';
  if n >= 120 then
    raise exception 'rate_limited';
  end if;
  delete from public.endless_attempts where user_id = p_user and created_at < now() - interval '1 day';
  insert into public.endless_attempts (user_id) values (p_user);

  select r.distance_cm into prev from public.endless_records r where r.user_id = p_user and r.week_key = p_week;
  improved := prev is null or p_distance > prev;
  if improved then
    insert into public.endless_records as r (user_id, week_key, distance_cm, polygon_json, shape_hash, species, lane, ticks, reason, sim_version, updated_at)
    values (p_user, p_week, p_distance, p_polygon, p_hash, p_species, p_lane, p_ticks, p_reason, p_sim_version, now())
    on conflict (user_id, week_key) do update
      set distance_cm = excluded.distance_cm, polygon_json = excluded.polygon_json, shape_hash = excluded.shape_hash,
          species = excluded.species, lane = excluded.lane, ticks = excluded.ticks, reason = excluded.reason,
          sim_version = excluded.sim_version, updated_at = now();
    best := p_distance;
  else
    best := prev;
  end if;
  select 1 + count(*) into rank from public.endless_records r join public.profiles p on p.user_id = r.user_id
   where r.week_key = p_week and p.status = 'active' and r.distance_cm > best;
  return next;
end $$;

-- ランキング：p_week が週キーならその週、'all' なら一人一件の歴代ベスト。省略時は今週
create or replace function public.get_endless_leaderboard(p_week text default null, p_limit integer default 20, p_offset integer default 0)
returns table (rank bigint, user_id uuid, display_name text, distance_cm integer, species text, week_key text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  off integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  wk text := coalesce(p_week, to_char(now() at time zone 'utc', 'IYYY-"W"IW'));
begin
  if wk = 'all' then
    return query
    select row_number() over (order by b.distance_cm desc, b.updated_at asc), b.user_id, p.display_name,
           b.distance_cm, b.species, b.week_key, b.updated_at
      from (select distinct on (r.user_id) r.* from public.endless_records r
             order by r.user_id, r.distance_cm desc, r.updated_at asc) b
      join public.profiles p on p.user_id = b.user_id
     where p.status = 'active'
     order by 1
     limit lim offset off;
  else
    return query
    select row_number() over (order by r.distance_cm desc, r.updated_at asc), r.user_id, p.display_name,
           r.distance_cm, r.species, r.week_key, r.updated_at
      from public.endless_records r join public.profiles p on p.user_id = r.user_id
     where r.week_key = wk and p.status = 'active'
     order by 1
     limit lim offset off;
  end if;
end $$;

revoke all on function public.submit_endless(uuid, text, integer, jsonb, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.submit_endless(uuid, text, integer, jsonb, text, text, integer, integer, text, text) to service_role;
revoke all on function public.get_endless_leaderboard(text, integer, integer) from public;
grant execute on function public.get_endless_leaderboard(text, integer, integer) to anon, authenticated, service_role;
