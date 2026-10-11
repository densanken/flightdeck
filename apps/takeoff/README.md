# Takeoff

指定した GitHub Organization の Pull Request（PR）を安全に squash merge するための GitHub App です。

Discord のスラッシュコマンドで操作できます。

## 主な機能とマージ判定（Merge Gate）

誤ったマージや壊れたコードの混入を防ぐため、以下の条件を**すべて**満たす PR のみマージを実行します。

- PR が `open` であり、ドラフト（Draft）状態でないこと
- タイトルに作業中プレフィックス（`[WIP]` など）が含まれていないこと（詳細は [@flightdeck/pr-title](../../packages/pr-title/README.md) 参照）
- タイトルが Conventional Commits に準拠していること
- 承認待ちの外部ワークフロー（`action_required`）が残っていないこと
- GitHub の判定で競合がなくマージ可能（`mergeable: true`）であること
- 対象ブランチの保護ルール（Rulesets / Branch Protection）で指定された必須チェック（Status Checks / Check Runs）がすべてパスしていること
  - ※Rules API が利用できない環境では、実行された全ステータスが成功していることを確認します
- 判定開始時点とマージ実行時点の HEAD コミット（SHA）が一致していること（二重マージ・割り込みマージの防止）

> **Note:**
>
> - マージ方法は **Squash merge** 固定です。コミットメッセージのタイトルは `<PRタイトル> (#<PR番号>)` となります。
> - 対象リポジトリの設定で **`Allow squash merging` が有効**になっている必要があります。
> - マージ完了後のブランチ自動削除は行いません。必要な場合は、GitHub 側で `Automatically delete head branches` を有効にしてください。

## Discord スラッシュコマンド

導入した Guild 内で以下のコマンドを利用できます。

| コマンド                          | 説明                                                        | 必要な権限                 |
| --------------------------------- | ----------------------------------------------------------- | -------------------------- |
| `/merge repo:<repo> pr:<number>`  | PR のマージ条件を検証し、満たしていれば squash merge を実行 | 一般メンバー               |
| `/status repo:<repo> pr:<number>` | PR の現在のマージ条件達成状況を確認                         | 一般メンバー               |
| `/sync repo:<repo>`               | リポジトリのキャッシュ情報を GitHub から再同期              | 一般メンバー               |
| `/repos`                          | 管理対象リポジトリの一覧を表示                              | 一般メンバー               |
| `/pulls repo:<repo>`              | オープンな PR 一覧を表示                                    | 一般メンバー               |
| `/repo add full_name:<repo>`      | 管理対象にリポジトリを追加（`owner/repo` 形式も可）         | 管理者（`ADMIN_ROLE_IDS`） |
| `/repo remove repo:<repo>`        | 管理対象からリポジトリを解除                                | 管理者（`ADMIN_ROLE_IDS`） |

> **CI 承認の自動トリガー:**
> `/merge` および `/status` コマンドを実行した際、同一 Organization メンバーによるフォーク元 PR で承認待ちになっている GitHub Actions があれば、自動的に承認処理を行ってから判定に進みます。

## セットアップ

リポジトリ全体の開発環境セットアップについては [Flightdeck の README](../../README.md) を参照してください。

### 1. GitHub App の作成とインストール

対象の GitHub Organization に以下の設定で GitHub App を作成・インストールします。

#### 権限（Permissions）

| 種別             | 項目            | 権限         | 用途                           |
| ---------------- | --------------- | ------------ | ------------------------------ |
| **Repository**   | Actions         | Read & write | 外部からの PR ワークフロー承認 |
|                  | Checks          | Read-only    | Check Run 状態の取得           |
|                  | Commit statuses | Read-only    | コミットステータスの取得       |
|                  | Contents        | Read & write | PR の squash merge 実行        |
|                  | Metadata        | Read-only    | リポジトリ情報の参照           |
|                  | Pull requests   | Read-only    | PR 情報の取得                  |
| **Organization** | Members         | Read-only    | 実行者の組織所属確認           |

#### Webhook

| 項目                    | 設定値                                                   |
| ----------------------- | -------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                |
| **Content type**        | `application/json`                                       |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定） |
| **SSL verification**    | Enable                                                   |
| **Subscribe to events** | `Workflow run`, `Repository`                             |

#### 秘密鍵（Private Key）の準備

Worker は **PKCS#8 形式**の秘密鍵のみサポートします。GitHub からダウンロードした PEM（PKCS#1）は、以下のコマンドで変換して `.env` に設定してください。

```bash
# ローカル開発環境の .env を直接更新する場合
pnpm run set-github-private-key -- github-app-private-key.pem

# 本番環境（Cloudflare Secret 等）用に手動で変換する場合
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

### 2. Discord Application の設定

1. [Discord Developer Portal](https://discord.com/developers/applications) で Application を作成します。
2. **General Information**: Application ID と Public Key を控えます。
3. **Interactions Endpoint URL**: `https://<worker-domain>/discord/interactions` を設定します。
4. **Bot**: トークンを取得し、対象の Guild（サーバー）へ Bot を招待します。トークンはスラッシュコマンドの登録だけに使用し、Worker の実行には不要です。

#### スラッシュコマンドの登録

環境変数を設定した状態でコマンドを実行し、Discord 側にスラッシュコマンドを登録します。

```bash
pnpm run register-commands
```

※コマンドの追加・更新時にもこのスクリプトを再実行してください。

## ローカル開発

### 1. 環境変数の準備

```bash
cp .env.example .env && chmod 600 .env
```

`.env.example` のコメントに従って各変数を設定します。

### 2. 開発サーバーの起動

```bash
pnpm dev
```

> **Webhook・Discord 連携のローカルテスト:**
> GitHub Webhook や Discord Interactions をローカルで受け取るには、Cloudflare Tunnel や ngrok などのトンネリングツールを利用して公開 URL を発行し、各サービス側に設定してください。

## 運用・仕様補足

### 外部フォーク PR の自動承認

フォーク元から作成された PR では GitHub Actions の実行に承認（`action_required`）が必要になります。Takeoff では以下の経路で自動承認を行います。

1. **Webhook:** `workflow_run.requested` 受信時に即座に自動承認。
2. **Discord コマンド:** `/status` または `/merge` 実行時に未承認 run があれば自動承認。

※PR 作成者が Organization メンバーでない場合はセキュリティ保護のため自動承認されません。

### 連続実行の制御（Cooldown）

連続リクエストによる負荷を防ぐため、マージおよび同期処理にはクーリングタイム（Cooldown）が設定されています。短時間に連続実行すると、Discord に「短い間隔で実行しています」という趣旨のメッセージが表示されます。その場合は、数秒置いてから再実行してください。

### 監査ログ通知

マージ操作のアカウント監査性を担保するため、マージ成功時に `MERGE_AUDIT_DISCORD_WEBHOOK_URL` 宛てに通知を送信します。

記録される内容は、実行した Discord ユーザー、対象 PR、コミット SHA、実行時刻などです。
