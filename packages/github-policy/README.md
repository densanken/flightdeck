# @flightdeck/github-policy

Clearance および Autopilot が、Pull Request の判定材料を GitHub から取得・評価するためのパッケージです。

GraphQL を用いたデータ収集（PR 情報、設定ファイル、ツリー構造、関連 PR、ソースリポジトリの履歴比較、Rules API など）と、通信回数の上限・エラー制御を提供します。必要なデータを取得しながら `@flightdeck/rules` のルールを順次適用し、PR を自動承認・マージしてよいかを判定します。

> [!NOTE]
> 本パッケージは判定結果の算出までを担当します。実際のレビュー承認やマージ操作の実行は呼び出し側の各アプリケーションが行ってください。

## モジュール構成

| モジュール                       | 役割                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `client`                         | 判定に必要な各種 GitHub データの取得                             |
| `ci`                             | CI ステータスの判定および必要に応じた Rules API 情報の取得       |
| `errors` / `error`               | エラーの分類および API レスポンスの検証                          |
| `evaluate`                       | `@flightdeck/rules` の規則を順次適用した PR の最終判定           |
| `request`                        | 認証処理、API 通信回数の上限管理、タイムアウト制御               |
| `query` / `schema` / `normalize` | GraphQL クエリ実行およびレスポンスの検証・データ正規化           |
| `timeline` / `timeline-events`   | 人間による操作履歴の判定に用いるタイムラインイベントの抽出・変換 |

公開されている関数および型定義の詳細は [src/index.ts](src/index.ts) を参照してください。

## テスト

```bash
pnpm --filter @flightdeck/github-policy test
```
