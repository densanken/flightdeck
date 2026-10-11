# @flightdeck/github-app-jwt

GitHub App として GitHub API を呼び出すための JWT（JSON Web Token）を生成するパッケージです。  
Installation Access Token の発行などに利用できます。

## 使い方

`createGitHubAppJwt` は、App ID と PKCS#8 形式の秘密鍵（PEM）を受け取り、RS256 アルゴリズムで署名した JWT を生成して返します。

```ts
import { createGitHubAppJwt } from "@flightdeck/github-app-jwt";

const jwt = await createGitHubAppJwt({ appId: "12345", privateKeyPem });
```

### 仕様・注意点

- **有効期限（`iat` / `exp`）:**  
  `iat`（発行時刻）は現在時刻の 60 秒前、`exp`（有効期限）は現在時刻の 540 秒後（9分後）に設定されます（GitHub API が許容する最大有効期間である 10 分以内に収まる設計です）。
- **PEM フォーマットの対応:**  
  改行文字が `\n` としてエスケープされた文字列も受け付けます。
- **PKCS#1 非対応:**  
  GitHub からダウンロードした初期状態の PKCS#1 形式（`BEGIN RSA PRIVATE KEY`）は読み込めません。あらかじめ `@flightdeck/private-key-env` などを使用して PKCS#8 形式へ変換してから渡してください。
- **エラーハンドリング:**  
  秘密鍵の指定が不正な場合、内部で利用している `jose` ライブラリのエラーをそのまま送出します。呼び出し側で独自のエラー型へ変換・キャッチする場合は、ログやメッセージに秘密鍵の内容が含まれないよう注意してください。

## 秘密鍵のキャッシュ構造

パフォーマンス最適化のため、インポート済みの鍵は Isolate 内にキャッシュされ、同一鍵に対する不要な再インポートを回避します。

- **安全なメモリ保持:**  
  キャッシュされるデータは「正規化済み PEM の SHA-256 ハッシュ値（指紋）」および「抽出不可な `CryptoKey` の Promise」のみです。
- 平文の PEM 文字列はキャッシュに保持されません。
