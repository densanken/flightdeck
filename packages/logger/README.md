# @flightdeck/logger

Cloudflare Workers 向けのログパッケージです。

## 使い方

`createLogger(minimumLevel, sink)` で logger を作成してください。
`minimumLevel` を省略すると `info` になり、`debug` の record は出力されません。
`sink` を省略すると `console` へ出力します。

```ts
import { createLogger } from "@flightdeck/logger";

const logger = createLogger("info");

logger.log("warn", { event: "github_api_failed", githubStatus: 403 });
// => {"event":"github_api_failed","githubStatus":403,"level":"warn","message":"github_api_failed"}
```

record の `event` は必須です。
`event` には、log を検索するときの key になる固定の名前を指定してください。
値の変わる情報は、`event` 以外の field に入れてください。

`createLogger` の型引数に record 型を渡すと、その型にない field 名を型エラーにできます。

```ts
interface AppLogRecord {
  event: string;
  deliveryId?: string;
}

const logger = createLogger<AppLogRecord>("info");
```

### 出力形式

- record の field の後に `level` と `message` を付けます
- Workers Logs は JSON の `message` field の値を一覧の message 欄に表示するため、`message` には `event` と同じ値を入れます
- record の文字列の値は、`redactSecrets` で秘密情報を秘匿化してから JSON にします

record が `level` や `message` を持っている場合、その値は logger が付ける値で上書きされます。

### 秘匿化の対象

`redactSecrets(message)` は、次の値を `<redacted>` に置き換えた文字列を返します。

- GitHub の token（`ghp_`, `ghs_`, `gho_`, `ghu_`, `ghr_`, `github_pat_` で始まる値）
- `Bearer`, `Bot`, `token` に続く 20 文字以上の credential 形式の値
- PEM 形式の秘密鍵
- Discord Webhook URL に含まれる token

秘匿化は既知の形式だけを対象にします。
request や response の body 全体、利用者の入力など、何が含まれるか分からない値は record に入れないでください。
GitHub API が返す top-level の `message` は record に入れることができます。
app が組み立てた error の message は、URL の query や外部から受け取った値など、credential を含みうる値を埋め込んでいないことを確認してから record に入れてください。
