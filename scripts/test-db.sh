#!/usr/bin/env bash
# ローカル PostgreSQL でマイグレーション・RLS・サーバー関数を検証する。
# 必要：PostgreSQL 15+ のサーバーバイナリ（initdb / pg_ctl / psql）
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb が見つかりません（PGBIN を設定してください）"; exit 1; }

WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  chmod 755 "$WORK"
  AS=(runuser -u postgres --)
fi
cleanup() { "${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "create database leaf"
PSQL+=(-d leaf)

"${PSQL[@]}" -f supabase/tests/local_stub.sql
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f supabase/tests/db_test.sql

# T06: resolve を同時に再送しても戦績は 1 回だけ更新される
"${PSQL[@]}" >/dev/null <<'SQL'
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000d1'), ('00000000-0000-0000-0000-0000000000d2');
select register_leaf('00000000-0000-0000-0000-0000000000d1', '[[0,0],[1,0],[0,1]]', 'x');
select register_leaf('00000000-0000-0000-0000-0000000000d2', '[[0,0],[1,0],[0,1]]', 'y');
update profiles set status = 'hidden' where user_id not in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
create table t06 as select id from create_challenge('00000000-0000-0000-0000-0000000000d1', 't06', 'tanbo', 1, '1.0.0');
SQL

pids=()
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "set role service_role; select resolve_race((select id from t06), 'challenger_win', 1, 2, '1.0.0', '2026-W42');" >/dev/null &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
streak=$("${PSQL[@]}" -tA -c "select current_streak || ',' || challenger_wins from stats where user_id = '00000000-0000-0000-0000-0000000000d1'")
events=$("${PSQL[@]}" -tA -c "select count(*) from race_events where race_id = (select id from t06) and event_type = 'resolved'")
[ "$streak" = "1,1" ] && [ "$events" = "1" ] || { echo "T06 FAILED: streak=$streak events=$events"; exit 1; }
echo "T06: 同時 8 重 resolve でも戦績更新は 1 回 ✓"

# 同じ冪等キーの同時 challenge は 1 件だけ作られる
"${PSQL[@]}" -c "update races set status='resolved' where status='pending'" >/dev/null
pids=()
for i in $(seq 1 6); do
  "${PSQL[@]}" -tA -c "set role service_role; select id from create_challenge('00000000-0000-0000-0000-0000000000d1', 'same-key', 'tanbo', 2, '1.0.0');" > "$WORK/c$i" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
n=$("${PSQL[@]}" -tA -c "select count(*) from races where idempotency_key = 'same-key'")
uniq=$(cat "$WORK"/c* | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l)
[ "$n" = "1" ] && [ "$uniq" = "1" ] || { echo "冪等 challenge FAILED: rows=$n ids=$uniq"; cat "$WORK"/c*; exit 1; }
echo "同時 challenge（同一キー）でも 1 件 ✓"
echo "DB tests passed"
