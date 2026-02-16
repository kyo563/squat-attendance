# スクワット出席アプリ 仕様定義（現行実装ベース）

この文書は、現行コード（`index.html` / `gas/Code.gs`）を基準に、仕様と要件を厳密化したものです。

## 1. システム構成
- フロントエンド: `index.html`（GitHub Pages 配信想定）
- バックエンド: Google Apps Script Web アプリ（`gas/Code.gs`）
- データストア: Google スプレッドシート（`Users` / `Attendance` / `Sessions` の3シート）

## 2. 機能要件

### 2.1 認証
- ユーザー登録
  - 入力: `userId`, `password`
  - `userId`: 英数字・`_`・`-`、3〜32文字
  - `password`: 4桁数字
  - 保存は `passwordSalt` + `SHA-256(salt:password)`（平文保存禁止）
- ログイン
  - `userId` + `password` を検証
  - 成功時、セッショントークンを発行し `Sessions` に保存
- ログアウト
  - クライアントは `logout` API を呼び、サーバーセッションを削除する
  - その後ローカル保存トークンを削除する

### 2.2 出席（チェックイン）
- ログイン済みユーザーのみチェックイン可能
- 1日1件（同日再実行時は上書き）
- `reps` は現行固定値 `30`

### 2.3 ダッシュボード
- 今日の日付、当月キー
- 自分の KPI（当月回数・連続日数・今日の完了状態）
- モデルユーザー（`MODEL_USER_ID`）の今日の完了状態
- 全体継続率（直近7日アクティブ率、当月日次平均率）

### 2.4 カレンダー表示
- 対象月の実施日を強調表示
- 当日強調表示
- 日本の祝日 API（`holidays-jp`）取得時は祝日装飾

## 3. API要件（`action`）
- `health`: ヘルスチェック
- `registerUser`: ユーザー登録
- `login`: ログイン
- `logout`: ログアウト
- `getDashboard`: ダッシュボード取得（認証必須）
- `getAttendance`: 月次出席取得（認証必須）
- `checkin`: チェックイン（認証必須）

共通レスポンス:
- 成功: `{ ok: true, ... }`
- 失敗: `{ ok: false, error, message }`

## 4. 非機能要件
- タイムゾーン: `Asia/Tokyo`
- セッション有効期限: `SESSION_EXPIRES_DAYS`（現行 `7` 日）
- 同時実行制御: `registerUser`, `checkin` で `LockService` 使用
- CORS回避: JSONP（`callback`）対応

## 5. 点検結果（不要・整理対象）
- **対応済み**: クライアントに未使用だった `TEMP_MODEL_USER_ID` を削除し、表示文言を実態に合わせた。
- **対応済み**: クライアントのログアウトがローカル削除のみだったため、`logout` API 呼び出しを追加しサーバーセッション削除を実施。
- **継続保留**: GAS の `mode` 互換ルーティングは後方互換のため現状維持。
