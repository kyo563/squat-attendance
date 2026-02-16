# スクワット出席アプリ用 GAS セットアップ

このリポジトリの `index.html` が呼び出す Google Apps Script（GAS）Web アプリの仕様と、必要なファイルを自動生成するための手順をまとめます。

## 仕様の正本
- 現行仕様の厳密定義はリポジトリ直下の `SPECIFICATION.md` を参照してください。
- この README は GAS セットアップ手順に特化し、要件定義との重複は最小化しています。

## データストア
- **Spreadsheet** を 1 つ用意し、以下 3 シートを作成します。スクリプトはシートが無い場合自動生成します。
  - `Users` シート: `userId, name, passwordSalt, passwordHash, createdAt, updatedAt`
  - `Attendance` シート: `date, userId, reps, createdAt`
  - `Sessions` シート: `token, userId, expiresAt, createdAt, updatedAt`
- スクリプト プロパティ `SPREADSHEET_ID` にシート ID を保存するか、`Code.gs` 内の `SPREADSHEET_ID` を書き換えてください。
- （任意）共有鍵を使う場合は `API_SHARED_KEY` を設定し、クライアントから `key` パラメーターで渡します。

## セキュリティ改善の要点
- 認証を `PIN` 単体から `userId + password` へ変更。
- `registerUser` 時に、`passwordSalt` と `SHA-256(passwordSalt:password)` を保存（平文パスワードは保存しない）。
- `login` 成功時にセッショントークンを発行し、`Sessions` シートで管理。
- `getAttendance` / `checkin`（および `getDashboard`）は `token` 必須。
- `SESSION_EXPIRES_DAYS`（`Code.gs` 定数）でセッション有効期限を管理し、期限切れトークンは失効。
- `logout` API を追加し、セッションを明示的に削除可能。
- 同時実行対策として `registerUser` と `checkin` に `LockService` を利用。

## API フォーマット
GAS Web アプリのデプロイ URL に対し `GET` で呼び出します。フロントエンドは JSONP のため `callback` パラメーターも付与します。

| action | 必須パラメーター | 返却内容（主要） |
| --- | --- | --- |
| `health` | なし | `{ok, timezone, now, sessionExpiresDays}` |
| `registerUser` | `userId, password(4桁数字)` | `{ok, message}` |
| `login` | `userId, password(4桁数字)` | `{ok, token, name, userId, expiresAt}` |
| `logout` | `token` | `{ok, message}` |
| `getDashboard` | `token` | `{ok, today, monthKey, me, model, retention}` |
| `getAttendance` | `token, month(YYYY-MM)` | `{ok, monthKey, monthDoneDates}` |
| `checkin` | `token`（`reps` 省略時は 30 として記録） | `{ok, message, date}` |

### 共通レスポンス
```jsonc
{
  "ok": true,
  "message": "補足メッセージ"
}
```

エラー時:

```jsonc
{
  "ok": false,
  "error": "error_code",
  "message": "エラー内容"
}
```

## セットアップスクリプト
`scripts/create_gas_template.sh` は GAS プロジェクト一式を `dist/` に生成します。

```bash
# SPREADSHEET_ID 環境変数を指定するとプレースホルダーが自動置換されます
SPREADSHEET_ID="your-sheet-id" ./scripts/create_gas_template.sh
```

生成物:
- `dist/gas/Code.gs`
- `dist/gas/appsscript.json`
- `dist/squat-gas.zip`（上記 2 ファイルをまとめた ZIP）

## デプロイ手順（概要）
1. Google ドライブで新規スプレッドシートを作成し、ID を控える。
2. Apps Script を開き、`dist/gas/Code.gs` と `appsscript.json` を上書きペースト。
3. スクリプト プロパティに `SPREADSHEET_ID`（必須）と `API_SHARED_KEY`（任意）を設定。
4. 「デプロイ」→「新しいデプロイ」→「種類: ウェブアプリ」から「全員」に公開。
5. 得られた Web アプリ URL を `index.html` の `DEFAULT_GAS_API_URL` または手動 URL 入力欄に設定。
