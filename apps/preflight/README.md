# Preflight

Pull Request（PR）の作成・更新をトリガーに、**作成者の自動アサイン**と **PR タイトルの検証**を行う GitHub App です。

## 主な機能

### 1. 作成者の自動アサイン

- PR の作成時（`opened`）および再オープン時（`reopened`）に、既存の Assignee を保持したまま作成者を Assignee に追加します。
- Bot が作成した PR はデフォルトで対象外です（`SKIP_BOTS=false` を設定することで Bot もアサイン対象にできます）。

### 2. PR タイトルの検証とステータス投稿

PR の HEAD コミットに対して `PR Title` という名前の Commit Status を投稿し、タイトルがプロジェクトの命名規約を満たしているかを判定します。

- **検証ルール:** [@flightdeck/pr-title](../../packages/pr-title/README.md)（Conventional Commits 準拠）に基づき検証します。
- **エラー時のコメント通知:** タイトルが無効な場合、修正案内コメントを PR に 1 件投稿します。タイトルが修正されるか PR がクローズされると、コメントは自動的に削除されます。
- **Draft / 作業中 PR の保留:**
  - GitHub 上の Draft PR、またはタイトルに `[WIP]` などの作業中プレフィックスが付いている PR は、エラーにせず `pending` として検証を保留します。
  - レビュー準備完了（`ready_for_review`）またはプレフィックスが削除されたタイミングで自動的に本検証が実行されます。

#### Commit Status の判定一覧

| State     | 主な条件                                                                   |
| --------- | -------------------------------------------------------------------------- |
| `success` | タイトルが命名規約に適合している、または関連するオープンな PR が存在しない |
| `pending` | 検証中、または Draft / 作業中プレフィックスが付いており保留中              |
| `failure` | タイトルが命名規約に違反している（修正が必要）                             |
| `error`   | GitHub API 連携など検証処理自体に失敗した                                  |

※同一の HEAD コミットを複数のオープン PR が共有している場合、すべての PR のタイトルが有効でなければ `success` にはなりません。

#### 変更ファイルに応じた type の設定

PR のベースブランチにある `.github/flightdeck.yml`（または `.github/flightdeck.yaml`）の `preflight` セクションに、変更ファイルのパスに応じた許可 `type` を定義することができます。

```yaml
preflight:
  title-types:
    - paths: ["docs/**", "*.md"]
      types: [docs, content]
```

##### 設定項目の仕様

| 項目        | 説明                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`paths`** | [picomatch](https://github.com/micromatch/picomatch) 形式の glob パターン配列（ドットファイルも対象）。<br>※ `*.md` はリポジトリ直下のみに一致します。全階層を対象とする場合は `**/*.md` を指定してください。 |
| **`types`** | 許可する type 名の配列（英小文字始まり、英小文字・数字・`_` のみ使用可）。<br>※ 既定の type 以外も独自に追加可能ですが、作業中マーカーと重複する `draft` / `wip` は指定不可（指定時は設定エラー扱い）。       |

##### 評価ルールとフォールバック挙動

- **許可される `type` の決定方法:**
  - **すべての変更ファイルがいずれかの `paths` に一致した場合:** 一致したルールの `types` の和集合（いずれかに含まれる type）のみが許可されます。
  - **ルールに一致しないファイルが 1 つ以上含まれる場合:** 既定の type 一覧に、一致したルールの `types` を加えたものが許可されます。
  - **どのルールにも一致しない場合 / 設定ファイルがない場合:** 既定の type のみで判定を行います。
- **リネームされたファイル:** 変更前と変更後の**両方**のパスが評価対象となります。
- **エラー時のフィードバック:** すべての変更ファイルがルール対象でありながら許可外の type が使われた場合、PR コメントと Commit Status に使用可能な type 一覧を案内します（文字数上限に収まらない場合はベースブランチの設定ファイルを確認してください）。
- **既定の type へのフォールバック条件:** 設定ファイルの不備・読取失敗、変更ファイル数が GitHub API 上限（3,000 件）を超過した場合、または通信予算不足時は、ログに記録したうえで既定の type で判定を行います。

> [!NOTE]
> ベースブランチへの `push` のみでは既存 PR の再検証は実行されません。設定変更後に既存 PR へ反映させるには、PR タイトルの編集または新しいコミットの `push` を行ってください。

## トリガーされるイベント

| イベント（`pull_request.action`）         | 作成者の自動アサイン |           タイトル検証           |
| ----------------------------------------- | :------------------: | :------------------------------: |
| `opened` / `reopened`                     |         実行         |               実行               |
| `edited`                                  |          -           | タイトルまたは base 変更時に実行 |
| `synchronize`（新コミット push）          |          -           |               実行               |
| `ready_for_review` / `converted_to_draft` |          -           |               実行               |
| `closed`                                  |          -           | クリーンアップ（コメント削除等） |

## セットアップ

リポジトリ全体の開発環境セットアップについては [Flightdeck の README](../../README.md) を参照してください。

### 1. GitHub App の作成

対象 Organization またはアカウントにて、以下の設定で GitHub App を作成します。

#### Repository permissions

| Permission          | Access         | 用途                                              |
| ------------------- | -------------- | ------------------------------------------------- |
| **Commit statuses** | Read and write | `PR Title` ステータスの更新                       |
| **Contents**        | Read-only      | 過去コミットの走査、base ブランチの設定の読み取り |
| **Pull requests**   | Read and write | 変更ファイルの取得、Assignee とコメントの管理     |
| **Metadata**        | Read-only      | リポジトリ基本情報の取得                          |

#### Webhook

| 設定項目                | 値                                                       |
| ----------------------- | -------------------------------------------------------- |
| **Webhook URL**         | `https://<worker-domain>/webhooks/github`                |
| **Content type**        | `application/json`                                       |
| **Secret**              | 任意の文字列（`.env` の `GITHUB_WEBHOOK_SECRET` に設定） |
| **Subscribe to events** | `Pull request`                                           |

### 2. 環境変数の設定

`.env` を作成し、必要なパラメータを設定します。

```bash
cp .env.example .env && chmod 600 .env
```

| 環境変数名               | 説明                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `GITHUB_APP_ID`          | GitHub App の App ID                                                         |
| `GITHUB_PRIVATE_KEY`     | PKCS#8 PEM 形式の秘密鍵                                                      |
| `GITHUB_WEBHOOK_SECRET`  | GitHub App に設定した Webhook Secret                                         |
| `GITHUB_APP_BOT_USER_ID` | GitHub App に紐づく Bot アカウントの数値 User ID                             |
| `SKIP_BOTS`              | （任意）Bot 作成の PR への自動アサインをスキップするか（デフォルト: `true`） |

#### App Bot User ID の確認方法

App ID や Installation ID ではなく、`<APP_SLUG>[bot]` の数値 ID が必要です。以下の API コマンドから取得できます（`<APP_SLUG>` は GitHub App 設定ページの URL 末尾の名前）。

```bash
curl -sS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/users/<APP_SLUG>%5Bbot%5D" | jq .id
```

#### 秘密鍵（Private Key）の準備

Worker は **PKCS#8 形式**の秘密鍵のみサポートします。ダウンロードした秘密鍵（PKCS#1）は以下のスクリプトで変換して `.env` に反映できます。

```bash
# ローカル開発環境の .env を直接更新する場合
pnpm run set-github-private-key -- github-app-private-key.pem

# 手動で変換する場合（Cloudflare Secret 登録時など）
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in github-app-private-key.pem -out github-app-private-key-pkcs8.pem
```

## ローカル開発

Worker を起動します。

```bash
pnpm dev
```

> [!TIP]
> GitHub からローカル環境へ Webhook を配信することはできないため、テスト時は [ngrok](https://ngrok.com/) や Cloudflare Tunnel などのトンネリングツールを利用して公開 URL を発行し、GitHub App の Webhook URL に設定してください。
