# Flightdeck

densanken における Pull Request の運用・管理を自動化するための GitHub App 群のリポジトリです。

## ワークスペース構成

| パス                       | パッケージ名                  | 概要                                                                                | ドキュメント                                 |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/private-key-env` | `@flightdeck/private-key-env` | GitHub App の秘密鍵（PEM）を PKCS#8 へ変換し `.env` に書き込む CLI / ユーティリティ | [README](packages/private-key-env/README.md) |

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
