# 公開までの手順（GitHub Pages ＋ Supabase）

Supabase を初めて触る人向けの手順です。**パソコンに何もインストールしなくて大丈夫**です（ブラウザだけで完結します）。
画面の文言は Supabase 側の更新で少し変わることがあります。見つからないときは近い名前のメニューを探してください。

所要時間の目安：30 分

---

## ステップ 1：GitHub Pages を有効にする（練習モードが遊べるようになる）

1. GitHub で `cadmium2525/Leaf-stream` を開く
2. 上のタブの **Settings** → 左メニューの **Pages**
3. 「Build and deployment」の **Source** を **GitHub Actions** にする（保存ボタンはありません。選ぶだけで OK）
4. 上のタブの **Actions** を開き、一番上の「CI」の実行を選んで **Re-run all jobs**（初回だけ。以降は push のたびに自動）
5. 緑のチェックになったら、`https://cadmium2525.github.io/Leaf-stream/` を開く

ここまでで、葉っぱの編集と練習レースがスマホでも遊べます。

---

## ステップ 2：Supabase のアカウントとプロジェクトを作る

1. https://supabase.com を開き、**Start your project** → **Continue with GitHub** でサインイン
2. 組織（Organization）の作成を求められたら、名前は何でも OK、プランは **Free** を選ぶ
3. **New project** を押して次のように入力
   | 項目 | 入力 |
   | --- | --- |
   | Project name | `leaf-stream` |
   | Database Password | **Generate a password** を押し、表示されたパスワードを**メモ帳などに保存**（ステップ 4 で使います） |
   | Region | **Northeast Asia (Tokyo)** |
4. **Create new project** を押して、1〜2 分待つ

> 💡 料金：Free プランのままなら請求は発生しません。クレジットカードの登録も不要です。
> ⚠️ Free プランは **1 週間アクセスが無いと一時停止**します。止まったら Supabase の管理画面でプロジェクトを開き **Restore** を押せば戻ります（データは消えません）。

---

## ステップ 3：ログインの設定（2 か所）

### 3-1. ゲストで遊べるようにする

1. 左メニューの **Authentication**（人の形のアイコン）
2. **Sign In / Providers**（または Settings）を開く
3. **Allow anonymous sign-ins** を **ON** にして **Save**

### 3-2. メールのリンクの戻り先

1. 同じ Authentication の中の **URL Configuration**
2. **Site URL** に `https://cadmium2525.github.io/Leaf-stream/` を入れて **Save**
3. **Redirect URLs** の **Add URL** で次の 2 つを追加
   - `https://cadmium2525.github.io/Leaf-stream/account`
   - `http://localhost:5173/account`

---

## ステップ 4：GitHub から Supabase へ自動で反映できるようにする

データベースの表やサーバーの処理は、GitHub Actions が自動で Supabase に送ります。そのための「鍵」を 3 つ、GitHub に預けます。

### 4-1. 3 つの値を集める

| 名前 | どこにあるか |
| --- | --- |
| **プロジェクト ID** | Supabase の左下の歯車 **Project Settings** → **General** → **Project ID**（英小文字 20 文字くらい。ブラウザの URL `.../project/<ここ>` と同じ） |
| **DB パスワード** | ステップ 2 で保存したもの |
| **アクセストークン** | 右上の自分のアイコン → **Account preferences** → **Access Tokens** → **Generate new token**（名前は `github-actions`）。**表示は一度きり**なのですぐコピー |

### 4-2. GitHub に登録する

1. GitHub のリポジトリ → **Settings** → 左メニュー **Secrets and variables** → **Actions**
2. **New repository secret** を 3 回押して、次の名前で登録

| Name | Secret |
| --- | --- |
| `SUPABASE_PROJECT_REF` | プロジェクト ID |
| `SUPABASE_DB_PASSWORD` | DB パスワード |
| `SUPABASE_ACCESS_TOKEN` | アクセストークン |

> 🔒 この 3 つは**チャットや Issue に貼らないでください**。GitHub の Secrets は暗号化され、ログにも表示されません。

### 4-3. 反映を実行する

1. GitHub の **Actions** → 左の一覧から **Supabase deploy** → 右の **Run workflow** → **Run workflow**
2. 2〜3 分で緑のチェックになれば成功
3. 確認：Supabase の左メニュー **Table Editor** に `profiles` `leaves` `races` `stats` などが並んでいれば OK

---

## ステップ 5：公開用の 2 つの値を教えてください

次の 2 つは**公開しても安全な値**です（ブラウザのアプリに埋め込むものです）。チャットで送ってください。こちらでアプリに設定して公開します。

| 名前 | どこにあるか |
| --- | --- |
| **Project URL** | **Project Settings** → **Data API**（または API）→ `https://xxxx.supabase.co` |
| **anon キー** | **Project Settings** → **API Keys** → **Legacy API Keys** タブの **anon** **public**（`eyJ...` で始まる長い文字列）。タブが無ければ **Publishable key**（`sb_publishable_...`） |

> ⛔ 同じ画面にある **service_role** / **secret** キーは**絶対に送らない・どこにも貼らない**でください。これはデータベースを何でも書き換えられる鍵です。

---

## うまくいかないとき

| 症状 | 対処 |
| --- | --- |
| Supabase deploy の「プロジェクトに接続」で失敗 | `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN` の貼り間違い（前後の空白に注意） |
| 「DB マイグレーション」で password authentication failed | `SUPABASE_DB_PASSWORD` が違う。Project Settings → Database → **Reset database password** で作り直して Secret を更新 |
| ゲームで「ゲストでの参加が無効になっています」 | ステップ 3-1 が OFF のまま |
| メールが届かない | Supabase 標準のメール送信は 1 時間に数通までの制限があります。少し待つか、迷惑メールフォルダを確認 |
| ランク戦で「受付を停止しています」 | Table Editor → `service_flags` の `ranked_enabled` が false。true にすると再開 |

## 運用メモ

- ランク戦をすぐ止めたいとき：Table Editor → `service_flags` → `ranked_enabled` を `false`
- 利用量の確認：左メニュー **SQL Editor** で `select * from usage_report();` を実行
- 有料プランへのアップグレードや、Spend cap（使いすぎ防止）の解除はしないでください
