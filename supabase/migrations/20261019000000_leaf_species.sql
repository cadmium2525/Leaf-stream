-- 葉っぱの種類（サクラ・ヤナギ・ナスタチウム・モミジ）。見た目と、どの形から切ったかを記録する
alter table public.leaves add column species text not null default 'sakura'
  check (species in ('sakura', 'yanagi', 'nasturtium', 'momiji'));
alter table public.races add column challenger_species text not null default 'sakura';
alter table public.races add column defender_species text not null default 'sakura';

grant select (species) on public.leaves to anon, authenticated;

drop function if exists public.register_leaf(uuid, jsonb, text);
create or replace function public.register_leaf(p_user uuid, p_polygon jsonb, p_hash text, p_species text default 'sakura')
returns public.leaves
language plpgsql security definer set search_path = public as $$
declare
  r public.leaves;
begin
  if not exists (select 1 from public.profiles where user_id = p_user and status <> 'banned') then
    raise exception 'profile_unavailable';
  end if;
  insert into public.leaves as l (user_id, version, polygon_json, shape_hash, species, active, rand_key, updated_at)
  values (p_user, 1, p_polygon, p_hash, p_species, true, random(), now())
  on conflict (user_id) do update
    set version = l.version + 1,
        polygon_json = excluded.polygon_json,
        shape_hash = excluded.shape_hash,
        species = excluded.species,
        active = true,
        updated_at = now()
  returning * into r;
  return r;
end $$;
revoke all on function public.register_leaf(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.register_leaf(uuid, jsonb, text, text) to service_role;

-- 挑戦作成時に両者の種類もスナップショットに残す
create or replace function public.copy_race_species() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select species into new.challenger_species from public.leaves where user_id = new.challenger_id;
  select species into new.defender_species from public.leaves where user_id = new.defender_id;
  new.challenger_species := coalesce(new.challenger_species, 'sakura');
  new.defender_species := coalesce(new.defender_species, 'sakura');
  return new;
end $$;
revoke all on function public.copy_race_species() from public, anon, authenticated;
create trigger races_copy_species before insert on public.races
for each row execute function public.copy_race_species();
