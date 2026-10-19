# 葉っぱ流し｜LEAF STREAM

日本の田舎の細い用水路に、自分で切った葉っぱを流して競う **非同期・葉っぱクラフトレース**（ブラウザゲーム）。

- 葉っぱは 4 種類（サクラ・ヤナギ・ナスタチウム・モミジ）から選び、指／マウスで自由に切れる（直線・V 字の切れ込みも可）。形が流れ方に物理的に効く
- 相手がオンラインでなくても、他の人の登録葉っぱとランダムに対戦できる
- 左右のスタート位置を入れ替えた 2 走の合計時間で勝敗。結果はサーバーが確定
- 連勝は「自分から挑戦したレース」だけで増減。挑戦された側は防衛記録のみ
- ユーザー登録・メール不要。初回の挑戦時にブラウザごとの匿名プレイヤーが自動で作られ、ランキングには自由な名前（1〜16 文字）で載る
- 月額 0 円（広告・課金・独自ドメインなし）で運用できる構成

企画書・開発指示書（版数 1.0／2026-10-18）の内容を実装しています。

**公開手順（GitHub Pages ＋ Supabase、ブラウザだけで完結）は [docs/SETUP.md](docs/SETUP.md) を参照。**

## すぐ遊ぶ（ローカル）

```bash
npm install
npm run dev        # http://localhost:5173
```

`.env` が無ければ **オフライン（練習のみ）** で動きます。葉っぱの編集・プレビュー水路・練習ボットとの 3D レースはすべて遊べます。

## 画面

| パス | 内容 |
| --- | --- |
| `/` | 用水路のデモ（ボット同士のレースを眺める）、各画面への導線 |
| `/editor` | 切断、Undo/Redo、形状検証、プレビュー水路、練習レース、登録。`?for=endless` でどこまでもモード用の葉（レース用とは別に保存） |
| `/race` | ランク戦／練習の選択、カウントダウン、観戦（追従／俯瞰、×1/×2/×4、走スキップ）、結果 |
| `/endless` | どこまでもモード：流す位置（左右）を決めて、詰まるまで観戦。距離を記録してランキングへ |
| `/leaderboard` | ランク戦（最高連勝・現在の連勝・今週の最高連勝）と、どこまでもモード（今週・歴代の距離）、ページ切替 |
| `/account` | 「プレイヤー」画面：ランキングに表示する名前、戦績、登録中の葉っぱ、データ削除 |
| `/about` | ルール、プライバシーポリシー、通報・問い合わせ、素材と権利 |

画質は「自動／高品質／標準／省電力」。自動のときは、fps が 3 秒続けて 26 を下回ると 1 段ずつ画質を下げます。

## 構成

```
packages/sim-core/    決定論的レースエンジン（UI・DOM 非依存、サーバーと共通）
  geometry.ts           外形の正規化・検証・切断（折れ線による分割）・ハッシュ
  course.ts             コース生成（シード）と 2D 流速場（ベース流・石・後流・渦・流れるノイズ）
  sim.ts                固定 dt の剛体シミュレーション、衝突、詰まり判定、2 走判定
  stats.ts              連勝・防衛の更新規則（DB 関数と同じ規則のリファレンス）
  replay.ts             確定済み軌跡の時刻補間（描画 fps に依存しない再生）
  bots.ts               練習用の相手
  species.ts            葉っぱの種類（元の形。座標はリテラルで持つ）
src/
  app/                  画面・ルーティング・設定
  render/               Three.js：水路・水面シェーダー・コースティクス・空・草・石・葉
  editor/               Canvas の切断エディタとプレビュー水路
  audio/                WebAudio で合成する環境音（水・鳥・虫・風鈴）
  api/                  Supabase クライアント（公開 anon キーのみ）
supabase/
  migrations/           スキーマ・RLS・サーバー関数（register / challenge / resolve / leaderboard）
  functions/            Edge Functions（Deno）：leaf-register / race-challenge / race-resolve / endless-submit / account-delete
  tests/                DB 統合テスト（ローカル PostgreSQL で実行）
tests/unit/             幾何・乱数・物理・戦績ルール・エディタ
```

### 描画と物理の分離

- 勝敗は `sim-core` の 2D 流速場だけで決まる。GPU の水面の波・葉の浮き沈み・カメラは見た目専用
- `sim-core` は `+ - * / sqrt` と整数演算だけで計算する（`Math.sin` 等は ESLint で禁止）。固定 dt = 1/60 秒、更新順固定、シード付き乱数
- 観戦は「計算済みの軌跡」を時刻で補間して再生するので、30fps でも 60fps でも結果は同じ
- Node（Vitest）と Deno（Edge Functions）で同じ入力から同じ結果になることを確認済み

### 葉っぱの物理

葉の外形から、内部サンプル点（裏面と水の摩擦）と各辺（縁の圧力抵抗・接線摩擦）を作り、点ごとの相対流速から力とトルクを計算します。幅・長さ・切れ込み・重心の位置で、流れへの乗り方・回転・石への引っかかり方が変わります。主な定数は `packages/sim-core/src/sim.ts` の `SIM`、形状ルールは `geometry.ts` の `LEAF_RULES` です。

| ルール | 値 |
| --- | --- |
| 1 走の制限時間 | 75 秒 |
| 未完走（時間切れ・詰まり） | 止まった時刻 ＋ 残り距離を基準流速で進む時間 ＋ 5 秒 |
| 詰まり判定 | 8 秒間で下流へ 4cm 進めない（2.5 秒進まないと渦が本流へ押し戻し始める） |
| 風 | 田んぼ：追い風 / 住宅街：向かい風 / 山里：谷を渡る風（強さ・横風の向きは日替わり）。見付け幅＋縁の長さに比例して受ける |
| 大きさ | 裏面の抵抗が (31.7/面積)^0.25 倍：小さい葉ほど流れになじみ、大きい葉は勢いを保つ |
| 引き分け | 合計の差が 2 tick（2/60 秒）以内、または両者とも全走ゴールできない |
| 葉の頂点数 | 3〜48 |
| 面積 | 6〜34 cm² |
| 細さの下限 | 2×面積/周長 ≥ 0.9 cm |
| 切断回数 | 16 回まで（エディタ側） |

シミュレーションの式や定数を変えたら `SIM_VERSION` を上げてください（ゴールデン値テストが失敗して知らせます）。未確定のレースは版の不一致で確定を拒否し、戦績に反映しません。

### どこまでもモード

`packages/sim-core/src/endless.ts`。レースと同じ物理（`stepBody`）で 1 枚の葉を流し続けます。

- コースは「区間」をつないだもの。区間の両端は半幅 18cm・中心 0 のまっすぐな水路で、葉が区間の終わりを越えると次の区間の頭へ移ります。見た目（田んぼ・住宅街・山里）は同じものが続かないように選びます
- 週キーからシードが決まり、全員が同じコースを流れます（毎週月曜 UTC に変わる）
- 仕掛け：**滝壺の逆流**（落ち口の下の水面が上流へ戻る。逆流より短い・軽い葉は抜け出せず、縦に回り続ける）、**杭の列**（隙間より幅の広い葉が引っかかる）。遠くへ進むほど数が増え、杭の隙間が狭く、逆流が長くなります
- レースと違い、引っかかっても押し出しません。6 秒間で 4cm 進めなければ終わり。制限時間は 8 分
- 記録は「進んだ最大距離（cm）」。サーバーが葉の形と流す位置（-10..10）から同じ計算をして確定します（Node と Deno で一致を確認）

## ランク戦（Supabase）を有効にする

手順は [docs/SETUP.md](docs/SETUP.md) にまとめています。要点：

1. Supabase（Free）でプロジェクトを作成し、匿名サインイン（Allow anonymous sign-ins）を ON（メールのログインは使わない）
2. GitHub の Actions Secrets に `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD` を登録し、**Supabase deploy** ワークフローを実行（マイグレーションと Edge Functions を反映）
3. 公開値（Project URL と anon / publishable キー）を `.env.production` に書いてコミット

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key または publishable key>
```

> **service_role / secret キーはブラウザ・`.env`・リポジトリに絶対に入れないこと。** Edge Functions の実行環境（Supabase が自動で注入）にだけ存在します。

ローカルで CLI を使う場合：`supabase link --project-ref <ref>` → `supabase db push` → `npm run sync:sim` → `supabase functions deploy`。

### API（論理契約 → 実装）

| 論理 | 実装 | 権限 |
| --- | --- | --- |
| `POST /leaf/register` | Edge `leaf-register` → `register_leaf()` | 本人認証、外形をサーバーで再検証、正規形のみ受理、version++ |
| `GET /leaf/me` | `leaves` テーブル（RLS） | 本人／公開中の葉のみ |
| `POST /race/challenge` | Edge `race-challenge` → `create_challenge()` | 本人認証、容量ガード、レート制限、相手抽選、スナップショット固定、冪等キー |
| `POST /race/{id}/resolve` | Edge `race-resolve` → `resolve_race()` | サーバーだけで計算、単一トランザクションで戦績更新、確定済みなら同じ結果 |
| `GET /race/{id}` | `races` テーブル（RLS） | 当事者のみ。観戦用の軌跡はスナップショットから端末で再計算 |
| `GET /leaderboard` | `get_leaderboard()` | 誰でも。1 回 50 件まで |
| `POST /endless/submit` | Edge `endless-submit` → `submit_endless()` | 本人認証、葉の形と流す位置からサーバーだけで距離を再計算、自己ベストのときだけ更新、1 時間 120 回まで |
| `GET /endless/leaderboard` | `get_endless_leaderboard()` | 誰でも。週キーか `all`（一人一件の歴代ベスト）。1 回 50 件まで |

- 相手抽選は `leaves.rand_key`（インデックス）で `ORDER BY random()` の全件ソートを避けています。相手がいなければ練習ボットに切り替え（ランク外）
- 未確定のランク戦は 1 ユーザー 1 件まで（部分ユニークインデックス）。10 分放置で失効、確定失敗は `failed` にして戦績に反映しません
- クライアントからのタイム・勝敗値は受け取りません

## 0 円運用ガードレール

- `service_flags.ranked_enabled = false` でランク戦の新規受付を即停止（練習は遊べる）
- `service_flags.monthly_race_limit` に達すると新規ランク戦を停止
- DB 容量が 400MB（Free の 500MB に対し余裕）を超えると `enforce_usage_guard()` が自動停止
- 利用量確認（SQL エディタ、service_role）：`select * from usage_report();`
- サーバー判定の実行時間：1 レース（2 走）の計算は Deno で中央値 約 25ms・最大 約 70ms（開発環境で 30 レース実測）。Edge Functions の CPU 上限内に収まる想定ですが、公開前に本番で実測してください。収まらない場合はランキングを公開せず練習版で止めます
- Cloudflare Workers（1 リクエスト CPU 10ms）にはサーバー判定を載せません
- Firebase は Cloud Functions に従量課金（Blaze）プランが必要なため採用していません
- ゲストは何個でも作れるため、挑戦は 1 分 6 回まで・Supabase 側の匿名サインインの IP 単位レート制限で抑えています

無料枠や利用条件は改定され得るため、デプロイ直前に各社の最新の公式資料を確認してください。

## テスト

```bash
npm test           # 単体テスト（Vitest）
npm run test:db    # DB 統合テスト（ローカルの PostgreSQL 15+ を一時起動）
npm run lint
npm run typecheck
npm run check:sim  # Edge Functions 用 sim-core のコピーが最新か
```

| ID | テスト | 場所 |
| --- | --- | --- |
| T01 | 自己交差の形は登録拒否・理由表示 | `tests/unit/geometry.test.ts`、エディタの検証表示、`leaf-register` |
| T02 | 同じ seed で 100 回再計算して一致 | `tests/unit/sim.test.ts` |
| T03 | 30fps/60fps・刻み方を変えても勝敗不変 | `tests/unit/sim.test.ts` |
| T04 | 他人の葉で対戦しても本人の葉は不変 | `supabase/tests/db_test.sql` |
| T05 | 防衛側の敗北は防衛敗北 +1、連勝不変 | `tests/unit/stats.test.ts`、`db_test.sql` |
| T06 | resolve を同時 8 重送信でも戦績更新は 1 回 | `scripts/test-db.sh` |
| T07 | 本人以外（本人も）の stats 直接更新は拒否 | `db_test.sql` |
| T08 | 無料枠の閾値で新規ランク戦を停止 | `db_test.sql` |
| T09 | レース中に葉を編集しても開始時スナップショットを維持 | `db_test.sql` |
| T10 | 相手が 0 人なら練習相手に切替 | `db_test.sql`、`/race` 画面 |

異常入力テストは、固定ケース＋ランダム生成 200 件＋ランダム切断 300 回です。

## 配信（GitHub Pages）

`main` への push で GitHub Actions（CI）が lint・型検査・テスト・DB テスト・ビルドを行い、通れば `https://<owner>.github.io/<repo>/` に公開します（`BASE_PATH` でサブパス配信、`404.html` で SPA のフォールバック）。初回はリポジトリの Settings → Pages → Source を **GitHub Actions** にしてください。

`supabase/` か `packages/sim-core/` が変わると **Supabase deploy** ワークフローが DB と Edge Functions を反映します（Secrets 未設定ならスキップ）。

## 素材と権利

テクスチャ（コンクリート・小石・草・葉脈・田んぼ）と環境音はすべてコードで生成しています。写真・録音・外部フォントは使っていません。ライブラリは three.js・supabase-js（いずれも MIT）。

## 未確定事項（試作で調整するもの）

- 記録はブラウザ単位。端末の引き継ぎ（メールを使わない引き継ぎコードなど）は未実装

- 2 走比較の所要時間（現状 1 走 15〜25 秒程度）、タイムアウト・ペナルティ・引き分けの閾値
- 葉の重量・厚み（現状は面密度一定）
- 登録時の編集制限、葉を大きく作り直したときの連勝の扱い（MVP は「維持」、各レースは登録バージョンで固定）
- 2 枚の葉は互いに衝突しない（ゴースト）。干渉させるかは公平性と合わせて要検討
- サーバー判定が無料枠の実行時間に収まるかの本番実測
