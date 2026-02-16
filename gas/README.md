# スクワット出席アプリ用 GAS セットアップ

このリポジトリの `index.html` が呼び出す Google Apps Script（GAS）Web アプリの仕様と、必要なファイルを自動生成するための手順をまとめます。

## データストア
- **Spreadsheet** を 1 つ用意し、以下 3 シートを作成します。スクリプトはシートが無い場合自動生成します。
  - `Users` シート: `userId, name, passwordHash, passwordSalt, createdAt, updatedAt`
  - `Attendance` シート: `date, userId, reps, createdAt`
  - `Sessions` シート: `token, userId, expiresAt, createdAt`
- スクリプト プロパティ `SPREADSHEET_ID` にシート ID を保存するか、`Code.gs` 内の `SPREADSHEET_ID` を書き換えてください。
- （任意）共有鍵を使う場合は `API_SHARED_KEY` を設定し、クライアントから `key` パラメーターで渡します。

## セキュリティ改善点（今回）
- `login` に **パスワード必須** を導入（平文保存はせず SHA-256 + salt で保存）。
- 認証後は `token`（セッション）を払い出し、`getAttendance` / `checkin` は token 必須。
- `Users` 一覧からパスワード関連情報は返さない。
- `register` / `checkin` は `LockService` で同時書き込み競合を回避。

## API フォーマット
GAS Web アプリのデプロイ URL に対し `GET` で呼び出します。全て JSON を返却します。

| mode | 必須パラメーター | 返却内容 |
| --- | --- | --- |
| `login` | `userId, password` | `{status, token, expiresAt, user, attendance, dashboard}` |
| `register` | `userId, name, password` | `{status, users, message}` |
| `getAttendance` | `token` | `{status, attendance, dashboard, user}` |
| `checkin` | `token` (`date`,`reps` は任意) | `{status, attendance, dashboard, message}` |
| `logout` | `token` | `{status, message}` |
| `dashboard` | なし | `{status, dashboard}` |

### 共通レスポンス
```jsonc
{
  "status": "ok" | "error",
  "message": "エラー内容 (error のとき)",
  "attendance": ["YYYY-MM-DD", ...],
  "users": [{"userId":"1234","name":"Alice"}, ...],
  "dashboard": {
    "modelToday": {"status":"進行中","desc":"..."},
    "ret": {"today":"75%","desc":"全体の継続率 ..."}
  }
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
