# @flightdeck/github-webhook-signature

GitHub Webhook の HMAC 署名（`X-Hub-Signature-256`）を検証するパッケージです。

## 使い方

`verifyGitHubWebhookSignature` にリクエストボディの生のバイト列、`X-Hub-Signature-256` ヘッダーの値、および Webhook Secret を渡して署名の妥当性を検証します（一致すれば `true`、不一致なら `false` を返します）。

```ts
import { verifyGitHubWebhookSignature } from "@flightdeck/github-webhook-signature";

const rawBody = new Uint8Array(await request.arrayBuffer());
const verified = await verifyGitHubWebhookSignature({
  rawBody,
  signatureHeader: request.headers.get("x-hub-signature-256") ?? "",
  secret,
});
```

## 仕様・注意点

- **`rawBody` には生のバイト列を指定:**  
  JSON としてパースする前のバイナリデータ（`Uint8Array` など）をそのまま渡す必要があります。一度パースしたオブジェクトを再度文字列化（`JSON.stringify`）して渡した場合、空白やエスケープ処理の差異により署名が一致しなくなります。
- **ヘッダーフォーマットの事前検証:**  
  ヘッダーの値が `sha256=` に続き 64 桁の 16 進数が並ぶ正しいフォーマット（`sha256=<hash>`）でない場合は、無駄な HMAC 計算を行わずに即座に `false` を返します。
- **タイミング攻撃（Timing Attack）対策:**  
  検証は `crypto.subtle.verify` が行い、比較に要する時間から一致の度合いは漏れません。そのため、呼び出し側でタイミング攻撃に対する追加の保護処理を実装する必要はありません。
