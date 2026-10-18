-- サーバー関数（service_role）がテーブルを読み書きできることを明示する。
-- プロジェクト作成時の「Automatically expose new tables」が OFF でも動くようにするため。
-- anon / authenticated（ブラウザ側）の権限はここでは一切増やさない。
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
