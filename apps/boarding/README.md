# Boarding

`densanken/blog-contents` の `main` ブランチに向けた Pull Request の認可・承認・自動マージを行う GitHub App です。

著者ディレクトリ配下の `authors/<author>/meta.yaml`（または `meta.yml`）の `editors` 定義と PR レビュー履歴をもとに変更権限を検証し、正当なコンテンツ更新の自動化と新規執筆者のオンボーディング・通知を担います。

モノレポ全体の開発環境セットアップについては [Flightdeck ルートの README](../../README.md) を参照してください。

## 主な機能

- **著者権限の検証と自動 Approve:** 変更パス、コミット作成者、Editor / Team 所属、レビュー状況を検証し、認可された `authors/<author>/**` のみの PR を自動 Approve します。
- **ステータスとコメントによるフィードバック:** 検証結果を `Boarding` Check に反映し、詳細な理由や修正手順を管理コメントとして投稿します。
- **イベント駆動での自動再評価:** `main` ブランチの更新や Org・Team のメンバー変更が発生した際、オープン中の関連 PR を自動的に再評価します。
- **外部 Fork PR の CI 自動承認:** 認可された著者コンテンツのみを変更する外部 Fork からの PR について、保留中（`action_required`）の CI ワークフローを自動承認します。
- **確認事項の検証と自動 Squash Merge:** PR テンプレート上の同意チェックと CI の全通過を確認したうえで、条件を満たす PR を自動で Squash Merge します。
- **新規執筆者の Discord 通知:** 新しい著者ディレクトリ（AuthorRoot）を作成する PR の申請時およびマージ完了時に Discord へ通知を送信します。

## トリガーイベント一覧

| イベント                                                                                                     | 処理内容                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **`pull_request`** (`opened`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `edited`) | PR の変更内容・権限・テンプレートチェックを再評価                                     |
| **`pull_request`** (`closed`)                                                                                | 管理コメントを最終状態に更新。マージ済みの場合は新規執筆者の登録完了を Discord に通知 |
| **`pull_request_review`** (`submitted`, `dismissed`)                                                         | App 自身のレビューを除き、レビュー状況の変化に応じて PR を再評価                      |
| **`check_suite` / `status`**                                                                                 | 対象コミットの全 CI が完了したタイミングで関連 PR を再評価                            |
| **`workflow_run`** (`requested`, `action_required` の完了)                                                   | 外部 Fork PR の対象 CI 承認および関連 PR の再評価                                     |
| **`push`**（`main` ブランチ）                                                                                | `main` をベースとするオープン中の全 PR を再評価                                       |
| **`membership` / `organization` / `team`**                                                                   | Org・Team の所属や権限変更に伴い、オープン中の関連 PR を再評価                        |

> [!NOTE]
> Team メンバーの役割変更（Maintainer 昇格など）のように GitHub から Webhook イベントが配信されない変更は自動検知されません。
> その場合は、対象 PR の本文編集や再オープンなど、再評価のトリガーとなる操作を行ってください。

## 認可ルールと PR テンプレート仕様

### 1. 変更パスによる認可マトリクス

| 変更内容                                         | 認可および App の挙動                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| **`authors/<author>/**` のみ**                   | 該当著者の Editor 権限と必要レビューを確認し、条件を満たせば自動 Approve          |
| **その他のみ（Org Member の PR）**               | 認可対象外として `Boarding` Check を `success` とし、人間のレビューに委ねる       |
| **著者の変更とその他が混在（Org Member の PR）** | 著者変更部分の正当性を検証（Check 成功）するが、App による自動 Approve は行わない |
| **上記以外を含む（Org Member 以外の PR）**       | 権限外の変更として `Boarding` Check を `failure` にする                           |

- 外部 Fork からの PR は、認可が成功し `authors/<author>/**` 以外の差分がない場合に限り、`.github/workflows/ci.yml` の `action_required` ワークフローを自動承認します。

### 2. 必須の確認事項（PR テンプレート）

`authors/` 配下を変更する PR（Org Member による PR や管理モードの PR を含む）では、PR 本文に以下のチェックリストが含まれ、**PR 作成者本人によって 3 つすべてにチェックが入っていること**を必須とします。

```md
- [ ] 私は CCS のメンバーまたは OB/OG です
- [ ] 投稿内容は公序良俗に反しません
- [ ] ガイドライン違反やその他運営上の都合により、管理者側で削除や非公開化などの対応を行うことに同意します
```

※未チェック、テンプレート文言の改変、作成者以外によるチェック、または編集履歴の検証不可の場合は `action_required` となり、自動承認・マージが保留されます（作成者本人が一度チェックを外して入れ直すことで再検証されます）。

### 3. 管理モード（Intervention / Offboarding）

通常の著者更新とは異なる管理操作を行う場合、Org Member である PR 作成者が以下のチェックボックスを選択して申請します（両方同時は不可）。

```md
- [ ] Org による管理介入を実施する（組織メンバーのみ可能）
- [ ] 外部 Editor のオフボーディングを実施する（組織メンバーのみ可能）
```

| モード                              | 対象と必要な承認条件                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intervention（管理介入）**        | 作成者以外の **Owner 1 名以上** ＋ **別の Org Member 3 名以上** の Approve（※2 人目以降の Owner も Member にカウント）                                                                                     |
| **Offboarding（外部 Editor 削除）** | Org 非所属の個人 Editor の削除（差分は `meta.yaml` / `meta.yml` の `editors` のみ）。作成者以外の **Owner 1 名以上** の Approve（後任を追加し既存 Editor が残る場合は、残存 Editor 1 名の Approve も必須） |

### 4. 自動マージの依頼

PR 本文の以下のチェックボックスに PR 作成者本人がチェックを入れることで、自動マージを予約できます。

```md
- [ ] すべてのチェックが成功したら自動マージする
```

PR が Draft でなく、差分が `authors/<author>/**` のみであり、認可・App の Approve・必須 CI（GitHub Actions のチェック 1 件以上を含む）がすべて完了した時点で自動的に Squash Merge を実行します。

## Discord 通知

新規の著者ディレクトリ（`AuthorRoot`）を作成する PR について、以下のタイミングで Discord チャンネルへ通知します。

| 通知種別             | 送信タイミング                       | 主な通知内容                                                                           |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| **執筆者の登録申請** | 対象 PR の初回（`opened`）評価完了時 | PR 作成者、AuthorRoot、Editor 候補、PR リンク、現在の認可状況、`authors/` 外変更の有無 |
| **執筆者の登録完了** | 対象 PR のマージ完了時               | AuthorRoot、確定した Editor、PR URL                                                    |

※通知は通常 `DISCORD_BOT_TOKEN` を用いて送信され、失敗時や未設定時の予備経路として `DISCORD_WEBHOOK_URL` が利用されます（通知の成否は PR の評価やマージ処理には影響しません）。

## セットアップ

### 1. GitHub App の作成とインストール

対象リポジトリに以下の設定で GitHub App を作成・インストールします。

#### 権限（Permissions）

| 種別             | 項目            | 権限         | 用途                                               |
| ---------------- | --------------- | ------------ | -------------------------------------------------- |
| **Repository**   | Actions         | Read & write | 外部 Fork PR の保留中 Workflow Run の照会・承認    |
|                  | Metadata        | Read-only    | リポジトリ情報の参照                               |
|                  | Contents        | Read & write | ファイル・コミット履歴の取得、Squash Merge 実行    |
|                  | Pull requests   | Read & write | PR・レビュー・差分の取得、コメント投稿、Approve    |
|                  | Checks          | Read & write | `Boarding` Check の作成・更新、CI 結果の確認       |
|                  | Commit statuses | Read-only    | CI Commit Status の確認                            |
| **Organization** | Members         | Read-only    | Org・Team の所属・役割の確認、権限変更イベント受信 |

#### Webhook 設定

| 項目                    | 設定値                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                                                                                    |
| **Content type**        | `application/json`                                                                                                           |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定）                                                                     |
| **Subscribe to events** | `Push`, `Pull request`, `Pull request review`, `Check suite`, `Status`, `Workflow run`, `Membership`, `Organization`, `Team` |

### 2. リポジトリの Ruleset 設定（必須）

`densanken/blog-contents` の `main` ブランチ保護のため、以下の Ruleset を必ず設定してください。

| 設定項目                                                             | 必須設定値                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Require a pull request before merging**                            | 有効（Required approvals: `1`）                                                                                         |
| **Dismiss stale pull request approvals when new commits are pushed** | **有効**（※App 承認後に `.github/**` 等が追加された際の不正マージ防止のため必須）                                       |
| **Allowed merge methods**                                            | `Squash` のみ                                                                                                           |
| **Require status checks to pass before merging**                     | **有効**（Expected Source に `Boarding` App と CI 各種 `fmt`, `content`, `test`, `typecheck`, `ClamAV`, `blog` を指定） |
| **Require branches to be up to date before merging**                 | 無効                                                                                                                    |
| **Bypass list**                                                      | なし（空）                                                                                                              |

> [!WARNING]
> Boarding 自体は記事コンテンツのセキュリティ検査を行いません。
> 運用開始前に必ず上記の CI チェックを導入し、Ruleset で必須化してください。

### 3. 環境変数・Queue の設定

`apps/boarding` ディレクトリで `.env` を作成します。

```bash
cp .env.example .env && chmod 600 .env
```

| 変数名                   | 説明                                                 |
| ------------------------ | ---------------------------------------------------- |
| `GITHUB_APP_ID`          | GitHub App の数値 App ID                             |
| `GITHUB_PRIVATE_KEY`     | PKCS#8 PEM 形式の秘密鍵                              |
| `GITHUB_WEBHOOK_SECRET`  | Webhook 署名検証用 Secret                            |
| `GITHUB_APP_BOT_USER_ID` | App Bot アカウントの数値 User ID                     |
| `DISCORD_BOT_TOKEN`      | Discord 通知用 Bot Token                             |
| `DISCORD_CHANNEL_ID`     | 通知先 Discord チャンネル ID                         |
| `DISCORD_WEBHOOK_URL`    | （任意）Bot 送信失敗時のフォールバック用 Webhook URL |

#### 秘密鍵の変換と Queue の準備

```bash
# ローカル開発用の .env 更新
pnpm run set-github-private-key -- github-app-private-key.pem

# 本番環境（Cloudflare Secret）用の手動変換
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

デプロイ前には、`wrangler.jsonc` に定義された Cloudflare Queues のキューをあらかじめ作成しておいてください。

## ローカル開発

```bash
pnpm --filter boarding dev
```

※ローカルで Webhook を受信する場合は、Cloudflare Tunnel 等で公開 URL を発行して GitHub App 側に設定してください。

## 運用・制限事項

### 主な制限値

| 対象                                  | 上限・制約             | 超過・エラー時の動作                                      |
| ------------------------------------- | ---------------------- | --------------------------------------------------------- |
| **PR の変更ファイル数**               | 300 件未満             | 300 件以上、または差分完全性が確認できない場合は評価失敗  |
| **API レスポンス / ページネーション** | 規定サイズ・ページ内   | 大きすぎる応答や取得失敗時は評価エラー                    |
| **Subrequest 予算**                   | Workers 上限内         | 予算超過時は評価を完了させず、可能な限り Check を失敗表示 |
| **Cloudflare Queues**                 | 設定されたリトライ回数 | 一時的な処理失敗時は自動的に再試行                        |

### ログイベント一覧（Workers Logs）

| イベント名 (`event`)         | 内容                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `evaluation`                 | PR の認可評価結果と理由コード                                     |
| `workflow_approval_skipped`  | 予算不足または一覧不完全による Fork CI 承認の見送り               |
| `workflow_approval_rejected` | GitHub API により拒否された Workflow Run 承認（HTTP status 付き） |
| `notification_failed`        | Discord 通知の送信失敗（失敗経路・HTTP status・`Retry-After`）    |
| `merge_rejected`             | GitHub API により拒否された Squash Merge（HTTP status 付き）      |
| `consume` / `enqueue_failed` | Queue メッセージの異常・再試行・投入失敗                          |
