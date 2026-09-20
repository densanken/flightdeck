# @flightdeck/private-key-env

GitHub App の秘密鍵を PKCS#8 形式に変換し、`.env` へ書き込むためのユーティリティパッケージです。

## スクリプトの実装

実行用スクリプトを用意し、`.env` に出力する環境変数名を第 1 引数 `key` に指定します。

```ts
import { runSetGitHubPrivateKeyCli } from "@flightdeck/private-key-env";

runSetGitHubPrivateKeyCli("GITHUB_PRIVATE_KEY", import.meta.url);
```

`runSetGitHubPrivateKeyCli` は、第 2 引数 `moduleUrl` に渡された `import.meta.url` が、エントリーポイントとして実行されたスクリプト（`process.argv[1]`）と一致する場合のみ CLI を起動します。

### 関数を直接呼び出す場合

CLI の引数解析やヘルプ表示を経由せず、直接処理を実行したい場合は `setGitHubPrivateKey(key, privateKeyPath, envPath)` を利用できます。

- 第 3 引数（`envPath`）を省略した場合の書き込み先は `.env` です。
- CLI とは異なりエラー時にプロセスを終了（exit）せず、例外をそのままスローするため、呼び出し側でエラーハンドリング（`try...catch`）を行ってください。

## CLI の使用方法

```
[--env-file <.env のパス>] <秘密鍵 PEM のパス>
```

秘密鍵 PEM のパスは必須です。`--env-file` を省略した場合の書き込み先は `.env` になります。

```bash
pnpm run set-github-private-key -- --env-file .env.local github-app-private-key.pem
```
