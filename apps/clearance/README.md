# Clearance

[Dispatch](../dispatch/README.md) が作成した Submodule 更新 PR と、一定期間人間の操作がない Renovate PR を自動承認（Approve）する GitHub App です。

モノレポ全体の開発環境セットアップについては [Flightdeck ルートの README](../../README.md) を参照してください。

## 主な機能

- **Dispatch PR の即時承認:**  
  PR 作成者のユーザー ID、管理ブランチ名、変更された Gitlink、ベースブランチの `.gitmodules`、およびソースリポジトリのコミット履歴を検証し、正当な更新であれば CI の完了を待たずに Approve します。
- **放置された Renovate PR の承認:**  
  Renovate による PR で、以下の条件をすべて満たす場合に Approve します。
  - 本文設定で Automerge が無効になっている
  - PR 作成および人間の最終操作（コメント、レビュー、GitHub の auto-merge の有効化・無効化など）から **30 日以上** 経過している
  - GitHub Actions の Check Run が 1 件以上存在し、すべての CI チェックが成功している
  - ※ファイルのリネーム（`RENAMED`）やコピー（`COPIED`）が含まれる PR は、安全のため自動承認を保留します。
- **条件不成立時のレビュー撤回（Dismiss）:**  
  Draft 化、Fork からの PR、`autopilot:skip` ラベルの付与、設定ファイルの変更、人間による `Changes requested` などが発生した場合、Clearance が行った既存の Approve の取り消し（Dismiss）を試みます（※撤回の成否はリポジトリの Branch Protection 設定に依存します）。

## トリガーイベント一覧

| イベント                                                                           | 処理内容                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`, `closed`) | 対象 PR の評価、および放置された古い Renovate PR の探索（`closed` は探索のみ） |
| `pull_request` (`converted_to_draft`, `labeled`, `unlabeled`, `edited`)            | 対象 PR の再評価・レビュー撤回判定（※`edited` 時は新規 Approve を行いません）  |
| `pull_request_review` / `pull_request_review_comment` / `issue_comment`            | 人間の操作検知および対象 PR の再評価（Clearance 自身の操作は除外）             |
| `check_suite` (`completed`) / `status`                                             | 関連 PR の CI 完了に伴う再評価（Renovate PR 向け）                             |

## 設定ファイル（`.github/flightdeck.yml`）

PR のベースブランチ直下に `.github/flightdeck.yml`（または `.github/flightdeck.yaml`）を配置することで動作をカスタマイズできます（省略時は既定値が適用されます）。

```yaml
autopilot:
  renovate-stale: false
```

| 項目                       | 必須 | 説明                                                                   |
| -------------------------- | :--: | ---------------------------------------------------------------------- |
| `autopilot.renovate-stale` | 任意 | 30 日放置された Renovate PR の自動承認を有効にするか（既定値: `true`） |

- `renovate-stale: false` を設定した場合でも、Dispatch PR の自動承認は引き続き有効です。
- 個別の PR だけ自動承認の対象外にしたい場合は、PR に **`autopilot:skip`** ラベルを付与してください。

> [!WARNING]
> **設定エラー時のフェイルセーフ動作**  
> YAML 構文エラー、32 KiB を超えるファイル、`.yml` と `.yaml` の併存、エイリアス（`*` / `&`）の使用、未知のキー指定などがあった場合は設定エラーとなります。エラー発生時は安全のため全ポリシーの自動承認を停止し、既存の Approve も Dismiss しません。

## セットアップ

### 1. GitHub App の作成とインストール

以下の権限・設定で GitHub App を作成し、対象リポジトリの Owner（ユーザーまたは組織）にインストールします。

> [!IMPORTANT]
> **Dispatch PR を承認する場合のインストール範囲**  
> ソースリポジトリの履歴を検証するため、ソースリポジトリも同じ Installation に含める必要があります。別 Owner のプライベートリポジトリなど、履歴を読み取れないソースリポジトリの Dispatch PR は承認されません。

#### 権限（Permissions）

| 種別           | 項目            | 権限         | 用途                                                                             |
| -------------- | --------------- | ------------ | -------------------------------------------------------------------------------- |
| **Repository** | Contents        | Read & write | 設定・Gitlink・履歴の取得、および Approve を必須レビューとしてカウントさせるため |
|                | Metadata        | Read-only    | リポジトリ情報の取得                                                             |
|                | Pull requests   | Read & write | PR の状態判定とレビューの Approve / Dismiss                                      |
|                | Checks          | Read-only    | Check Run 状態の取得                                                             |
|                | Commit statuses | Read-only    | Commit Status の取得                                                             |
|                | Issues          | Read-only    | ラベルやコメントの取得                                                           |

> [!NOTE]
> `Contents` の Write 権限はコードの Push には使用しません。GitHub の仕様上、リポジトリへの書き込み権限を持たないレビュアーの Approve は「必須レビュー（Required reviews）」の人数としてカウントされないため、Write 権限が必要になります。

#### Webhook 設定

| 項目                    | 設定値                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                                                                      |
| **Content type**        | `application/json`                                                                                             |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定）                                                       |
| **Subscribe to events** | `Pull request`, `Pull request review`, `Pull request review comment`, `Issue comment`, `Check suite`, `Status` |

### 2. 環境変数の設定

`apps/clearance` ディレクトリで `.env` を作成し、必要な値を設定します。

```bash
cp .env.example .env && chmod 600 .env
```

| 変数名                   | 説明                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `GITHUB_APP_ID`          | GitHub App の App ID                                               |
| `GITHUB_PRIVATE_KEY`     | PKCS#8 PEM 形式の秘密鍵                                            |
| `GITHUB_WEBHOOK_SECRET`  | Webhook Secret                                                     |
| `GITHUB_APP_BOT_USER_ID` | Clearance 自身の Bot アカウントの数値 User ID                      |
| `DISPATCH_BOT_USER_ID`   | Dispatch の Bot アカウントの数値 User ID                           |
| `RENOVATE_BOT_USER_IDS`  | 対象とする Renovate Bot の数値 User ID（カンマ区切りで複数指定可） |

- `.env.example` には公式の Mend Renovate（`renovate[bot]`）の ID が記載されています。Self-hosted の Renovate を利用する場合は、対象の Bot ID に置き換えるかカンマ区切りで追加してください。
- 本番環境では Cloudflare Dashboard（Secrets / Variables）に設定します。

#### 秘密鍵（Private Key）の変換

Worker は **PKCS#8 形式** の秘密鍵のみサポートします。ダウンロードした PEM（PKCS#1）は以下で変換してください。

```bash
# ローカル開発用（.env を直接更新）
pnpm run set-github-private-key -- github-app-private-key.pem

# 本番環境用（Cloudflare Secret 登録時など）
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

## ローカル開発

Worker を起動します。

```bash
pnpm --filter clearance dev
```

> [!TIP]
> ローカル環境で Webhook を受信する場合は、Cloudflare Tunnel 等を利用して公開 URL を発行し、GitHub App の Webhook URL に設定してください。

## 運用・制限事項

- **放置期間と探索上限:**  
  Renovate PR は作成および人間の最終操作から **30 日経過** している必要があります。また、1 回のイベントにつき探索される対象は「古いオープン PR の先頭 100 件のうち最大 5 件」までです。
- **Worker 実行制限による評価の延期:**  
  Cloudflare Workers のサブリクエスト上限（45 回）や実行時間制限（25 秒）に近づいた場合、処理は途中で安全に打ち切られ、次回以降のイベントへ評価が延期されます。
- **Self-hosted Renovate 利用時の注意:**  
  `git push` 方式で動作する Self-hosted Renovate を使う場合、コミット作成者が GitHub アカウントに紐づいていないと「人間の操作」と判定され、30 日のカウントがリセットされ続けます。`gitAuthor` を `<数値ID>+<login>@users.noreply.github.com` 形式に設定するか、Renovate の Platform Commit 機能を使用してください。

### ログイベント一覧（Workers Logs）

`event` フィールドで検索・フィルタリングが可能です（すべてのログに `delivery_id`, `installation_id`, `repository_id` が共通付与されます）。

| イベント名 (`event`)  | 内容                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `evaluation`          | PR ごとの判定結果およびレビュー操作（Approve / Dismiss）の記録         |
| `evaluation_deferred` | サブリクエスト数または実行時間の上限到達による評価の延期               |
| `job_failed`          | 設定ファイル不備（`configuration_error`）や API エラー等による処理失敗 |
