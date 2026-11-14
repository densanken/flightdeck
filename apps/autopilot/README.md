# Autopilot

Clearance が承認した Pull Request を再評価し、条件を満たす場合に自動で Squash Merge を実行する GitHub App です。

モノレポ全体の開発環境セットアップについては [Flightdeck ルートの README](../../README.md) を参照してください。

## 主な機能

- **対象 PR の評価:** Dispatch による Submodule 更新 PR、および 30 日以上人間の操作がない Renovate PR を評価します。
- **承認と CI の最終確認:** 現在の HEAD コミットに対する Clearance の Approve と、すべての必須 CI の成功を確認します。
- **安全な自動マージ:** 評価時点の HEAD SHA を指定して Squash Merge を実行します（評価後の割り込みコミットによる誤マージを防止）。

## トリガーイベント一覧

| イベント                            | 処理内容                                   |
| ----------------------------------- | ------------------------------------------ |
| **`pull_request_review.submitted`** | レビューが投稿された対象 PR を再評価       |
| **`check_suite.completed`**         | チェックが完了した関連 PR を再評価         |
| **`status`**                        | 対象コミットに関連付く PR を取得して再評価 |

## 設定ファイル（`.github/flightdeck.yml`）

PR のベースブランチにある `.github/flightdeck.yml`（または `.github/flightdeck.yaml`）を読み込みます。

```yaml
autopilot:
  renovate-stale: false
```

- **`autopilot.renovate-stale`:** `false` を指定すると、放置された Renovate PR を自動マージの対象から除外します（デフォルト: `true`）。
- **PR 単位での無効化:** PR に `autopilot:skip` ラベルを付与すると、その PR の自動化を停止できます。

詳細な判定ルールの仕様については [共通規則（`@flightdeck/rules`）](../../packages/rules/README.md) を参照してください。

## セットアップ

### 1. GitHub App の作成とインストール

対象の親リポジトリと Dispatch のソースリポジトリを、**同一の Installation** に含めてインストールしてください。

#### 権限（Permissions）

| 種別           | 項目            | 権限         | 用途                                               |
| -------------- | --------------- | ------------ | -------------------------------------------------- |
| **Repository** | Metadata        | Read-only    | リポジトリ情報および Rules API の参照              |
|                | Pull requests   | Read-only    | PR およびレビュー状態の参照                        |
|                | Contents        | Read & write | 設定ファイル・履歴の参照、および Squash Merge 実行 |
|                | Checks          | Read-only    | Check Run の参照                                   |
|                | Commit statuses | Read-only    | Commit Status の参照                               |
|                | Issues          | Read-only    | コメントおよびタイムライン履歴の参照               |
|                | Workflows       | Read & write | `.github/workflows/` を変更する PR のマージ許可    |

#### Webhook 設定

| 項目                    | 設定値                                                   |
| ----------------------- | -------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                |
| **Content type**        | `application/json`                                       |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定） |
| **Subscribe to events** | `Pull request review`, `Check suite`, `Status`           |

### 2. 環境変数の設定

`.env.example` を参考に環境変数を設定してください。本番環境には以下の変数をすべて登録してください。

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `DISPATCH_BOT_USER_ID`
- `RENOVATE_BOT_USER_IDS`
- `CLEARANCE_BOT_USER_ID`

#### 秘密鍵（Private Key）の変換

Worker は **PKCS#8 形式**の秘密鍵のみサポートします。ダウンロードした PEM（PKCS#1）は以下のコマンドで変換してください。

```bash
# ローカル開発用（apps/autopilot ディレクトリで実行し .env を更新）
pnpm run set-github-private-key -- github-app-private-key.pem

# 本番環境（Cloudflare Secret 等）用
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

## ローカル開発

`apps/autopilot` で `.env` を作成・設定したうえで、開発サーバーを起動してください。

```bash
pnpm --filter autopilot dev
```

## 運用・制限事項

- **GitHub 保護ルールの遵守:** ブランチ保護ルール（Branch Protection / Rulesets）や Merge Queue の制限は迂回しません。GitHub 側でマージが拒否された場合は処理を停止します。
- **Webhook 欠落時のリカバリ:** 本 Worker は耐久キュー（Queues）を使用しません。Clearance のレビューイベント欠落や CI 完了直後の反映遅延（pending 状態）により処理が進まなかった場合は、GitHub App 設定画面の **Recent Deliveries** から該当イベントを手動で再配信（Redeliver）してください。

### 主な制限値

| 対象                         | 上限        | 超過時の動作                                                                                               |
| ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| **GitHub API 通信回数**      | 45 回       | 処理を安全に停止                                                                                           |
| **1 回の API タイムアウト**  | 10 秒       | 処理を安全に停止                                                                                           |
| **Webhook 応答後の処理時間** | 25 秒       | 処理を安全に停止                                                                                           |
| **PR の関連データ取得件数**  | 100 件      | ラベル・ファイル・レビュー・CI 等が全件取得できない場合は停止                                              |
| **タイムライン取得件数**     | 最新 100 件 | 未取得の過去履歴があり、取得分がすべて 30 日以内なら対象外（※30 日以上前の履歴が含まれていれば判定を続行） |

### ログイベント一覧（Workers Logs）

| イベント名 (`event`) | 内容                                                       |
| -------------------- | ---------------------------------------------------------- |
| `evaluation`         | PR 情報の取得結果、ルール判定、およびマージ実行結果        |
| `job_failed`         | 認証エラー、関連 PR の特定失敗、設定不備などによる異常終了 |
