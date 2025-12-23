# スクワット出席アプリ用 GAS セットアップ

このリポジトリの `index.html` が呼び出す Google Apps Script（GAS）Web アプリの仕様と、必要なファイルを自動生成するための手順をまとめます。

## データストア
- **Spreadsheet** を 1 つ用意し、以下 2 シートを作成します。スクリプトはシートが無い場合自動生成します。
  - `Users` シート: `pin, name, createdAt, updatedAt`
  - `Attendance` シート: `date, pin`
- スクリプト プロパティ `SPREADSHEET_ID` にシート ID を保存するか、`Code.gs` 内の `SPREADSHEET_ID` を書き換えてください。
- （任意）共有鍵を使う場合は `API_SHARED_KEY` を設定し、クライアントから `key` パラメーターで渡します。

## API フォーマット
GAS Web アプリのデプロイ URL に対し `GET` で呼び出します。全て JSON を返却します。

| mode | 必須パラメーター | 返却内容 |
| --- | --- | --- |
| `login` | `pin` | `{status, name, users, attendance, dashboard}` |
| `register` | `pin, name` | `{status, users, message}` |
| `getAttendance` | `pin, month(YYYY-MM)` | `{status, attendance, dashboard}` |
| `checkin` | `pin, date(YYYY-MM-DD)` | `{status, attendance, dashboard, message}` |
| `dashboard` | なし | `{status, dashboard}` |

### 共通レスポンス
```jsonc
{
  "status": "ok" | "error",
  "message": "エラー内容 (error のとき)",
  "attendance": ["YYYY-MM-DD", ...], // ユーザーの全記録
  "users": [{"pin":"1234","name":"Alice"}, ...], // 全ユーザー一覧
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

