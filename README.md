# Flightdeck

densanken における Pull Request の運用・管理を自動化するための GitHub App 群のリポジトリです。

## ワークスペース構成

| パス                       | パッケージ名                  | 概要                                                                                | ドキュメント                                 |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/preflight`           | `preflight`                   | PR 作成者の自動アサインと PR タイトル検証                                           | [README](apps/preflight/README.md)           |
| `packages/pr-title`        | `@flightdeck/pr-title`        | Conventional Commits に準拠した PR タイトル検証ロジック                             | [README](packages/pr-title/README.md)        |
| `packages/private-key-env` | `@flightdeck/private-key-env` | GitHub App の秘密鍵（PEM）を PKCS#8 へ変換し `.env` に書き込む CLI / ユーティリティ | [README](packages/private-key-env/README.md) |

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
