# Flightdeck

densanken における Pull Request の運用・管理を自動化するための GitHub App 群のリポジトリです。

## ワークスペース構成

| パッケージ名                                                                          | 概要                                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`preflight`](apps/preflight/README.md)                                               | PR 作成者の自動アサインと PR タイトル検証                                           |
| [`takeoff`](apps/takeoff/README.md)                                                   | Discord スラッシュコマンドからの安全な PR マージ実行                                |
| [`dispatch`](apps/dispatch/README.md)                                                 | ソースリポジトリの更新を親リポジトリの Submodule へ反映する PR の自動作成           |
| [`clearance`](apps/clearance/README.md)                                               | dispatch と放置された Renovate PR の自動承認                                        |
| [`@flightdeck/github-app-jwt`](packages/github-app-jwt/README.md)                     | GitHub App 認証用 JWT 生成パッケージ                                                |
| [`@flightdeck/github-webhook-signature`](packages/github-webhook-signature/README.md) | GitHub Webhook の署名（`X-Hub-Signature-256`）の検証                                |
| [`@flightdeck/logger`](packages/logger/README.md)                                     | logger                                                                              |
| [`@flightdeck/pr-title`](packages/pr-title/README.md)                                 | Conventional Commits に準拠した PR タイトル検証ロジック                             |
| [`@flightdeck/private-key-env`](packages/private-key-env/README.md)                   | GitHub App の秘密鍵（PEM）を PKCS#8 へ変換し `.env` に書き込む CLI / ユーティリティ |
| [`@flightdeck/rules`](packages/rules/README.md)                                       | 設定ファイル・命名規則・承認判定の共通規則                                          |

※PR タイトルの命名規約（利用可能な type、scope、全角記号の制限など）については、[@flightdeck/pr-title のドキュメント](packages/pr-title/README.md#タイトルの検証ルール) を参照してください。

## 開発環境のセットアップ

ランタイムおよびパッケージマネージャーの管理には [mise](https://mise.jdx.dev/) の使用を推奨します。

### 1. ランタイムの準備

#### mise を使用する場合（推奨）

```bash
mise trust
mise install
```

#### 手動でセットアップする場合

以下のツールをインストールしてください。

- **Node.js**（バージョンは [.nvmrc](.nvmrc) を参照）
- **Corepack**

インストール後、Corepack を有効化して適切な pnpm を利用可能にします。

```bash
corepack enable
```

### 2. 依存関係のインストール

プロジェクトルートで以下を実行します。

```bash
pnpm install
```

## ローカル開発

アプリケーションごとに必要な環境変数が異なります。起動前に各アプリのディレクトリで `.env` を作成してください（詳細は各アプリの README を参照）。

起動するアプリを `--filter` で指定して開発サーバーを立ち上げます。

```bash
# Preflight の起動
pnpm --filter preflight dev

# Takeoff の起動
pnpm --filter takeoff dev

# Dispatch の起動
pnpm --filter dispatch dev
```

## コマンド一覧

リポジトリ全体の静的解析、フォーマット、テスト、ビルドを行うスクリプトです。

```bash
# Lint チェック
pnpm lint:check

# コードフォーマットの検証
pnpm fmt:check

# テストの実行
pnpm test

# 全パッケージのビルド
pnpm build
```
