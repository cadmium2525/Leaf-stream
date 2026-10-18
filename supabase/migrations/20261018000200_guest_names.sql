-- ゲスト（匿名サインイン）向け：新規ユーザーに「葉っぱ1234」のような仮の名前を付ける
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, '葉っぱ' || lpad((floor(random() * 10000))::int::text, 4, '0'))
  on conflict do nothing;
  insert into public.stats (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
