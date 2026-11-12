# Dispatch

ソースリポジトリの最新コミットを、親リポジトリの Git Submodule に自動反映し、更新 Pull Request を作成・管理する GitHub App です。

ソースリポジトリ側に置いた YAML ファイルで設定することで、1つのソースリポジトリから複数の親リポジトリへ同時に更新 PR を作成することができます。

モノレポ全体の開発環境セットアップについては [Flightdeck ルートの README](../../README.md) を参照してください。

## 主な機能

- **自動 PR 作成・更新:** ソースリポジトリのデフォルトブランチに `push` されると、親リポジトリの Submodule（gitlink）を最新コミットへ更新する PR を作成します。
- **手動コミットの上書き:** 管理ブランチに手動で直接コミットしても、次回同期時に自動で上書きされます。
- **不要・重複 PR の自動クローズ:** 設定解除などで更新が不要になった PR や重複 PR は、タイトル末尾に ` - autoclosed` を付与して自動クローズします。

## トリガーイベント一覧

| イベント                                            | 処理内容                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **ソース側の `push`**（デフォルトブランチ）         | 設定されたターゲットリポジトリごとに同期。設定から除外されたターゲットの PR は自動クローズ                             |
| **親側の `push`**（該当ブランチ）                   | そのブランチを Base とする管理ブランチの PR を同期                                                                     |
| **管理ブランチへの `push`**                         | 該当ターゲットを同期し、手動コミットを自動上書き                                                                       |
| **`repository.edited`**（デフォルトブランチ変更）   | ソース側の変更時は新デフォルトブランチの設定で同期（旧設定の PR はクローズ）。親側の変更時は全管理ブランチの PR を同期 |
| **`pull_request`** (`opened`, `reopened`, base変更) | 管理ブランチの PR である場合、即座にターゲットを同期（重複 PR のクローズ・Base 修正を含む）。※Fork からの PR は対象外  |

## 設定ファイル（`.github/flightdeck.yml`）

ソースリポジトリのデフォルトブランチ直下に `.github/flightdeck.yml`（または `.github/flightdeck.yaml`）を配置してください。

Dispatch の設定は `dispatch:` キー配下に記述してください。

```yaml
dispatch:
  targets:
    - repository: densanken/blog
      path: contents
```

### 設定項目一覧

| 項目                    |   必須   | 説明                                                                    |
| ----------------------- | :------: | ----------------------------------------------------------------------- |
| `dispatch.targets`      | **必須** | 更新先親リポジトリの設定配列（最大 20 件）。`[]` で更新先なしを指定可能 |
| `targets[].repository`  | **必須** | 親リポジトリの `owner/repo` 名（※リネーム後の最新表記）                 |
| `targets[].path`        | **必須** | 親リポジトリ内にある既存 Submodule のパス                               |
| `targets[].base-branch` |   任意   | PR の送信先ベースブランチ（省略時は親リポジトリのデフォルトブランチ）   |

### 設定上の注意事項・エラー条件

- **パス指定:** `path` の先頭・末尾の `/` は無視されます（例: `/contents/` ＝ `contents`）。`..` や制御文字は使用できません。
- **ベースブランチ:** 指定した `base-branch` が親リポジトリに存在しない場合は設定エラーとなります（デフォルトブランチへの自動フォールバックはしません）。
- **親リポジトリの重複禁止:** 同一の親リポジトリを複数指定することはできません（大文字小文字の違いも不可）。
- **ファイル制限:** ファイルサイズは 32 KiB 以下、独自タグやエイリアス（`*` / `&`）は使用不可。`flightdeck.yml` と `flightdeck.yaml` の併存はエラーとなります。
- **リポジトリ名制限:** ソースリポジトリ名が `.` で始まる場合、`.lock` で終わる場合、`..` を含む場合はブランチ作成不可のためエラーとなります。

> [!WARNING]
> 設定ファイルを書き換え可能なユーザーは、App がアクセスできる任意の親リポジトリに対して PR を作成させることができます。設定ファイルの変更には CODEOWNERS や Branch Protection によるレビューを必須にしてください。

## 親リポジトリ側の前提条件

Dispatch は Submodule の新規追加・削除や `.gitmodules` の書き換えは行いません。以下を満たさないターゲットは設定エラーとして無視されます。

1. ベースブランチのツリー上で、`path` の要素が **Gitlink（`mode: 160000`）** として登録されていること
2. 同一コミットの `.gitmodules` に、該当 `path` の設定が存在すること
3. `.gitmodules` 内の `url` がソースリポジトリの現在の正しい場所（GitHub 上の URL）を指していること
   - 対応形式: `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo(.git)`
   - ※相対パスや GitHub 以外のホストはエラーになります。ソースリポジトリをリネームした場合は `.gitmodules` も更新してください。

## セットアップ

### 1. GitHub App の作成とインストール

以下の権限・設定で GitHub App を作成し、ソースおよび親リポジトリの Owner（ユーザー/組織）にインストールします。

#### 権限（Permissions）

| 種別           | 項目          | 権限         | 用途                                                     |
| -------------- | ------------- | ------------ | -------------------------------------------------------- |
| **Repository** | Contents      | Read & write | 設定ファイルの読み取り、コミット比較、管理ブランチの更新 |
|                | Metadata      | Read-only    | リポジトリ情報・デフォルトブランチの取得                 |
|                | Pull requests | Read & write | 管理ブランチの PR 作成・更新・クローズ・再オープン       |

※ `Workflows` 権限は不要です（親リポジトリの `.github/workflows/` が更新された場合でも動作します）。

#### Webhook 設定

| 項目                    | 設定値                                                   |
| ----------------------- | -------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                |
| **Content type**        | `application/json`                                       |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定） |
| **Subscribe to events** | `Push`, `Repository`, `Pull request`                     |

#### 管理ブランチの保護設定（Bypass List）

Dispatch は管理ブランチに Force Push を行います。親リポジトリで `flightdeck-dispatch/` 関連のブランチ保護ルール（Rulesets）を設定している場合は、Dispatch の GitHub App を **Bypass List** に追加してください。

### 2. 環境変数の設定

`apps/dispatch` ディレクトリで `.env` を作成します。

```bash
cp .env.example .env && chmod 600 .env
```

| 変数名                  | 説明                    |
| ----------------------- | ----------------------- |
| `GITHUB_APP_ID`         | GitHub App の App ID    |
| `GITHUB_PRIVATE_KEY`    | PKCS#8 PEM 形式の秘密鍵 |
| `GITHUB_WEBHOOK_SECRET` | Webhook Secret          |

#### 秘密鍵（Private Key）の変換

Worker は **PKCS#8 形式** の秘密鍵のみサポートします。ダウンロードした PEM（PKCS#1）は以下で変換してください。

```bash
# ローカル開発用
pnpm run set-github-private-key -- github-app-private-key.pem

# 本番環境（Cloudflare Secret 等）用
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

## ローカル開発

Worker を起動します。

```bash
pnpm --filter dispatch dev
```

> [!TIP]
> ローカルで Webhook を受信する場合は、Cloudflare Tunnel 等を利用して公開 URL を発行し、GitHub App 側に設定してください。

## 運用・制限事項

### 主な制限値

| 対象                                     | 上限   | 上限超過時の動作                                                                                             |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| **親リポジトリ内の Submodule 数**        | 100 件 | 該当ターゲットの同期をスキップ                                                                               |
| **親リポジトリ内の管理ブランチ数**       | 100 本 | 親リポジトリ全体の同期をスキップ                                                                             |
| **1つの管理ブランチに対する Open PR 数** | 10 件  | 該当ターゲットの同期をスキップ（親側の `push` やデフォルトブランチ変更では親リポジトリ全体の同期をスキップ） |

- **コミット一覧表示の制限:** PR 本文に記載されるコミット一覧は、GitHub API の制約により最新の 250 件まで表示されます。また、差分サイズが 1 MiB を超える場合は CPU 時間保護のため一覧表示が省略されます。
- **非公開リポジトリからの更新:** ソースリポジトリが非公開で親リポジトリが公開の場合、PR 本文にはコミットの一覧を載せず、件数だけを記載します。

### ログイベント一覧（Workers Logs）

`event` フィールドで検索・フィルタリングが可能です。

| イベント名 (`event`)      | 内容                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `target_synced`           | ターゲットの同期成功（`outcome`: `created`, `updated`, `unchanged`, `autoclosed`） |
| `target_removed`          | 設定から外されたターゲットの PR を自動クローズ                                     |
| `pull_request_reopened`   | クローズ済み PR の再オープン成功                                                   |
| `reopen_failed`           | 再オープン失敗につき、新規 PR を作成                                               |
| `sync_failed` / `consume` | 設定エラー、権限不足、リトライ処理、制限オーバーなどの記録                         |
