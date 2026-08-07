# Cloudflare移植指示書（Claude Codeにそのまま貼る用）

- 作成日: 2026-08-06
- 使い方: `~/Desktop/monomane-sugoroku` でClaude Codeを起動し、下の「---」以下を全部コピーして貼り付ける

---

# タスク

PHP + SQLiteで動いている「街のモノまねすごろく」のバックエンドを、Cloudflare Pages Functions + D1 に移植する。フロントエンド（HTML/CSS/JS）は原則そのまま流用し、Cloudflare Pagesにデプロイして誰でもURLでアクセスできる状態にする。

# 成果物

このリポジトリ（monomane-sugoroku）内に以下を作成・変更する。

- `functions/api/[[path]].js` … 既存PHP APIと同一仕様のCloudflare Pages Functions実装
- `migrations/0001_init.sql` … D1のスキーマ定義
- `wrangler.toml` … Pages + D1のバインディング設定
- `package.json` … wranglerを開発依存に追加
- `test_api_cf.sh` … Cloudflare版のAPIテスト（既存 `test_api.sh` のCloudflare版）
- `README.md` … Cloudflare版のセットアップ・デプロイ手順を追記
- 既存の `api/*.php` と `router.php` は**削除せず残す**（自前Apache版として維持し、READMEで2つの実装を併記する）

# 前提・制約

- **写真はD1にBLOBで保存する。R2は使わない**（R2は支払い方法の登録が必要なため。D1無料枠はDB 500MB・1行2MBまで）
- 写真は**クライアント側で長辺1000px・JPEG品質0.75に縮小**してから送る（1枚150〜250KB想定。既存の `shrinkImage()` の値を変更する）
- 既存のフロント側APIパス（`api/rooms`、`api/photos/{id}` 等）は**変更しない**。Functions側を同じパスで実装する
- 認証は現行どおり「部屋コード＋X-Player-Tokenヘッダ」。アカウント登録は作らない
- openrouteserviceのAPIキーは `wrangler secret` / Pagesの環境変数（`ORS_API_KEY`）で管理し、**フロントには絶対に出さない**（現行の `api/secrets.php` 相当）
- PHPの `getimagesize()` によるMIME検証と再エンコード（EXIF除去）は、Workers環境では画像ライブラリが使えないため、**マジックバイト検証＋クライアント側でCanvas再エンコード済みであること**で代替する（Canvas経由の時点でEXIFは落ちる。この方針変更はREADMEに明記する）
- 期限切れ部屋の削除は、現行の「1/20の確率で実行」をそのまま移植する（Cron Triggersは使わない）（前提）
- `data/spots.geojson`（2.6MB）は静的ファイルとしてPagesから配信する

# 移植対象のAPI仕様（現行 `api/index.php` と完全に同じ挙動にする）

| メソッド | パス | 内容 | 認証 |
|---|---|---|---|
| POST | `/api/rooms` | 部屋作成。6桁コード発行 | 不要 |
| POST | `/api/rooms/{code}/join` | 参加。playerToken発行 | 不要 |
| GET | `/api/rooms/{code}/state` | 盤面・メンバー・写真・採点を返す | 要 |
| POST | `/api/rooms/{code}/progress` | 自分の現在マスを報告 | 要 |
| POST | `/api/rooms/{code}/photos` | 写真アップロード（multipart） | 要 |
| POST | `/api/rooms/{code}/finish` | 部屋終了 | 要（ホストのみ） |
| DELETE | `/api/rooms/{code}/players/me` | 退出 | 要（ホスト不可） |
| GET | `/api/photos/{id}` | 写真配信 | 要（部屋メンバーのみ） |
| POST | `/api/photos/{id}/reactions` | 絵文字リアクション（得点非影響） | 要（本人不可） |
| POST | `/api/photos/{id}/publish` | ネット公開 | 要（本人のみ） |
| DELETE | `/api/photos/{id}/publish` | 公開取り下げ | 要（本人のみ） |
| GET | `/api/gallery` | 公開ギャラリー一覧 | 不要 |
| GET | `/api/gallery/{id}/image` | 公開画像 | 不要 |
| POST | `/api/gallery/{id}/votes` | 星投票（1ブラウザ1票） | 不要 |
| POST | `/api/gallery/{id}/reports` | 通報（3件で自動非公開） | 不要 |
| POST | `/api/route` | ORSへのプロキシ（徒歩経路） | 不要 |

# 絶対に変えてはいけない仕様

移植の過程でこれらが壊れていないことを、テストで必ず確認すること。

1. **自分の写真には自分でリアクションできない**（403を返す）
2. **得点 = 基礎点 × AIの星(1〜5) + 電柱ボーナス（電柱ありで +5、電柱もAIが判定）**
   ※ 旧仕様は「基礎点 × みんなの星の平均」だったが、採点をAIに全任せする方針に変更。人の相互採点は廃止し、得点に影響しない絵文字リアクションへ降格した。
3. **ネット投票・リアクションは部屋の得点に一切影響しない**（完全に別集計）
4. **ネット公開できるのは撮影した本人だけ**（他人は403）
5. **公開を取り下げると、公開用画像と投票が即座に削除される**
6. **部屋の写真は、その部屋のメンバーしか見られない**（トークン検証。なければ403）
7. 部屋は作成から30日で自動削除
8. 部屋コードは紛らわしい文字（I/L/O/0/1）を除いた6桁英数
9. ニックネームは1〜10文字、1部屋あたり最大8人
10. 使えるリアクション絵文字は許可リストのみ（範囲外は400）

# 完了条件（すべて満たすまで完了としない）

1. `npx wrangler pages dev` でローカル起動し、`test_api_cf.sh` の全項目がパスする
2. 上記「絶対に変えてはいけない仕様」10項目が、テストスクリプト内で明示的に検証されている（特に 1・3・4・5・6 は個別のテストケースとして存在する）
3. ブラウザでローカル起動版を開き、部屋作成 → 別ブラウザで参加 → サイコロ → デモ到着 → 写真送信 → 相手側で採点、の一連が動作する
4. `wrangler.toml` にD1バインディングがあり、`migrations/0001_init.sql` を適用するとテーブルが全て作成される
5. ORSのAPIキーがフロントのソース（`assets/js/`, `index.html`）に含まれていない（grepで確認）
6. Cloudflare Pagesにデプロイされ、発行されたURL（`https://*.pages.dev`）でスマホからアクセスして遊べる
7. `README.md` に「Cloudflare版」「自前Apache版」両方のセットアップ手順が書かれ、D1にBLOB保存する設計判断とその容量見積り（500MB ÷ 200KB ≒ 2,500枚）が記載されている

# 検証（完了報告の前に必ず自分で実施）

- 条件1 → `bash test_api_cf.sh` を実行し、全項目の出力を確認する
- 条件2 → テストスクリプトを読み、10項目それぞれに対応するアサーションがあることを確認。特に「ネット投票後も部屋得点が変わらない」ことを数値で assert する
- 条件3 → ローカルでブラウザ2つ（通常＋シークレット）を使い実際に操作する。コンソールにエラーが出ていないことも確認
- 条件4 → `npx wrangler d1 execute <DB名> --local --command "SELECT name FROM sqlite_master WHERE type='table'"` でテーブル一覧を確認
- 条件5 → `grep -rn "ORS_API_KEY\|api.openrouteservice" assets/ index.html` を実行し、キー本体が出ないことを確認
- 条件6 → デプロイ後のURLに実機（またはブラウザのモバイルエミュレータ）でアクセスし、盤面生成まで動くことを確認
- 条件7 → READMEを読み返し、上記の記載があることを確認
- 検証で失敗したら修正して再検証。全通過まで繰り返す

# 実行方針

- 計画を立ててから着手し、最後まで自律的に完遂する。途中経過の確認は不要
- Cloudflareアカウントの作成・ログイン（`wrangler login`）・D1データベースの作成が必要な場面では、実行すべきコマンドを提示して一度だけ確認を取る
- 既存のPHP実装（`api/lib.php`, `api/index.php`）を読んで、SQLとバリデーションのロジックを忠実に移植すること。仕様を推測で変えない
- 不明点は上記の前提に従って判断し、置いた仮定は完了報告に明記する
- 完了報告: 成果物の場所 / 各完了条件の判定結果 / 置いた仮定 / デプロイURL

---

## 補足（この指示書を渡す前にやっておくこと）

1. Cloudflareアカウントを作る（無料・クレジットカード不要）: <https://dash.cloudflare.com/sign-up>
2. ターミナルで `cd ~/Desktop/monomane-sugoroku` してからClaude Codeを起動する
3. Claude Codeに上の「---」以下を貼る

## 移植後の運用メモ

- Cloudflare版は `https://monomane-sugoroku.pages.dev` のようなURLで公開される（HTTPS付き）ので、そのままスマホで遊べる。テストプレイ（P5）はこれで実施できる
- GitHubにpushすると自動でデプロイされる設定にもできる（Pages の Git連携）
- 無料枠の目安: D1は 5GB/アカウント・DB 500MB、読み取り約1.5億行/月・書き込み約300万行/月。授業規模なら十分
