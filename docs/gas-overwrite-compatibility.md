# GAS上書き互換性チェック（Code.gs）

## 結論
提示された旧仕様の `Code.gs` をそのまま上書きすると、**現行 `index.html` とは互換性がなく動作しません**。

## 主な不一致ポイント

1. 認証パラメータが異なる
   - 現行フロント: `action=login&userId=...&password=...`
   - 提示コード: `action=login&pin4=...`（4桁PINのみ）

2. 登録APIの入力が異なる
   - 現行フロント: `action=registerUser&userId=...&password=...`
   - 提示コード: `action=registerUser&displayName=...&pin4=...`

3. シート構造が異なる
   - 現行実装前提: `Users / Attendance / Sessions`
   - 提示コード前提: `Users / Checkins` + `Setup.gs` の補助関数依存

4. 共有キーのパラメータ名が異なる
   - 現行: `key`
   - 提示コード: `k`

## 改良案（安全な移行順）

### 案A（推奨）
- 現行 `gas/Code.gs` を維持し、必要な機能だけを取り込む。
- 取り込み対象候補:
  - `checkinBundle` / `loginBundle`
  - `getAttendance` の返却形式拡張
- ただし既存インターフェース（`userId/password`）を壊さない。

### 案B（旧仕様を使いたい場合）
- `index.html` 側を旧仕様API（`pin4/displayName`）に合わせて全面改修する。
- さらに `Setup.gs` を同一GASプロジェクトへ追加し、シート定義も `Checkins` 前提へ揃える。

## 最小リスク対応
- まずは案Aで、現行APIを維持したまま必要機能のみ段階導入。
- 互換レイヤー（例: `pin4` 受け取り時に内部で `userId/password` へ変換）を設けると移行事故を減らせます。
