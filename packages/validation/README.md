# @flightdeck/validation

GitHub の識別子や環境変数の検証を共通化するためのパッケージです。

## 使い方

```ts
import { githubId, requiredId, requiredString } from "@flightdeck/validation";
import * as v from "valibot";

const result = v.safeParse(githubId, 123);
const id = requiredId("123", "GITHUB_APP_BOT_USER_ID");
const secret = requiredString("secret", "GITHUB_WEBHOOK_SECRET");
```

### 主な機能と仕様

- `githubId`、`commitSha`、`repositoryFullName` は、外部データの検証に使用してください。
- `configObject` は、手書きの設定オブジェクトから配列を除外するために使用してください。
- `splitRepository` は、リポジトリの `full_name` を `owner` とリポジトリ名に分割します。
- 環境変数の読み取り関数は、不正な値に対して `ConfigurationError` を送出します。
- 必須文字列の検証（`requiredString` など）では、空白を除いた状態で値の存在を確認し、問題なければ元の値をそのまま返します。
