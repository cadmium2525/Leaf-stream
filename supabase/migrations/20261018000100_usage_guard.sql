-- 無料枠ガードレール：利用量の確認と、閾値でのランク戦自動停止
create or replace function public.usage_report()
returns table (db_bytes bigint, races_this_month bigint, monthly_race_limit integer, ranked_enabled boolean, leaves bigint, users bigint)
language sql stable security definer set search_path = public as $$
  select pg_database_size(current_database()),
         (select count(*) from public.races where created_at >= date_trunc('month', now())),
         f.monthly_race_limit,
         f.ranked_enabled,
         (select count(*) from public.leaves),
         (select count(*) from public.profiles)
    from public.service_flags f where f.id = 1;
$$;

-- DB 容量が上限（既定 400MB：Free の 500MB に余裕を持たせる）を超えたらランク戦を止める
create or replace function public.enforce_usage_guard(p_db_limit_bytes bigint default 400 * 1024 * 1024)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if pg_database_size(current_database()) >= p_db_limit_bytes then
    update public.service_flags set ranked_enabled = false, updated_at = now() where id = 1;
    return false;
  end if;
  return (select ranked_enabled from public.service_flags where id = 1);
end $$;

revoke all on function public.usage_report() from public, anon, authenticated;
revoke all on function public.enforce_usage_guard(bigint) from public, anon, authenticated;
grant execute on function public.usage_report() to service_role;
grant execute on function public.enforce_usage_guard(bigint) to service_role;
