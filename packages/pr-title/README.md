# @flightdeck/pr-title

Conventional Commits 形式に従った Pull Request のタイトルを検証するパッケージです。

## 使い方

`validatePullRequestTitle(title)` はタイトル文字列を受け取り、検証結果を返します。

```ts
import { validatePullRequestTitle } from "@flightdeck/pr-title";

const result = validatePullRequestTitle("feat(api): add endpoint");
if (result.valid) {
  // result.parsed: { type, scope, breaking, description }
} else {
  // result.reason: 失敗理由
}
```

### 失敗理由（`result.reason`）一覧

| `reason`                 | 説明                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `valid`                  | 検証成功（問題なし）                                                                  |
| `empty`                  | タイトルが空、または空白文字のみ                                                      |
| `surrounding_whitespace` | 先頭または末尾に不要な空白がある                                                      |
| `invalid_format`         | 形式（`<type>(<scope>)<!>: <description>`）の不一致、または制御文字・不可視文字を含む |
| `fullwidth_symbol`       | タイトル内に全角または CJK の記号を含んでいる                                         |
| `unsupported_type`       | 許可されていない type が指定されている                                                |
| `invalid_scope`          | scope の文字種、境界、または `/` の指定が不正                                         |
| `invalid_description`    | description の先頭文字または末尾文字が不正                                            |

### WIP / Draft の判定

`hasDraftTitleMarker(title)` を使用して、タイトルの先頭に作業中を示すプレフィックス（接頭辞）が付いているかを判定できます。

```ts
import { hasDraftTitleMarker } from "@flightdeck/pr-title";

hasDraftTitleMarker("[WIP] feat: add login"); // true
hasDraftTitleMarker("feat: add login"); // false
```

- 対象プレフィックス: `[WIP]`, `WIP:`, `[draft]`, `draft:`（大文字・小文字を区別しません）
- 先頭の空白はトリムして判定されます（例: `  WIP: add login` も検出可能）。
  - ※元の文字列をそのまま `validatePullRequestTitle` に渡すと、先頭空白により `surrounding_whitespace` となります。
- `[WIP]` / `[draft]` を含むタイトルは `invalid_format`、`WIP:` / `draft:` は `unsupported_type` として判定されます。

これら 2 つの関数を組み合わせることで、「形式違反として修正を促す」か「作業中（Draft）として検証を保留する」かを呼び出し側で制御できます。

## タイトルの検証ルール

基本フォーマットは [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) に準拠します。

```text
<type>(<optional scope>)<optional !>: <description>
```

### 1. Type

次の 11 種類のみを受け付けます（すべて英小文字）。
`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

### 2. Scope（任意）

- 使用可能文字: 英小文字、数字、`-`, `.`, `_`, `/`
- 先頭および末尾は必ず英小文字または数字である必要があります。
- `/` を 2 つ以上含めることはできません。

### 3. Description

- **先頭文字:** 英小文字（`a`-`z`）、半角数字、漢字、ひらがな、カタカナのいずれかで始まる必要があります。
  - 全角英数字（`Ａ`, `１`）、`〆`、長音符（`ー`）、絵文字で始まる場合は `invalid_description` になります（※文中で使用することは可能です）。
- **末尾文字:** 以下の 6 文字で終わることはできません（置かれた場合は `invalid_description`）。
  ```text
  . , ; : ! ?
  ```
- **文中文字:** 英大文字、絵文字、Issue 番号（`#123`）、ASCII 記号を自由に使用できます。

### 4. 制御文字・不可視文字

タイトルのいかなる場所にも、一般カテゴリが制御（`Cc`）または書式（`Cf`）の文字、および半角スペース以外の空白文字を含めることはできません。

- ゼロ幅スペース（`U+200B`）、NBSP（`U+00A0`）、垂直タブ（`U+000B`）、全角スペース（`U+3000`）等を含む場合は、見た目が正しくても `invalid_format` になります。
- 例外として、ゼロ幅接合子（ZWJ: `U+200D`）で絵文字をつないだシーケンス（例: `👩‍💻`）のみ許可されます。

### 5. 全角記号・CJK 記号の禁止

全角記号および CJK 記号は、description の末尾だけでなくタイトルのどの位置にも含めることができません（含まれる場合は `fullwidth_symbol`）。

- **対象文字（禁止）:**
  Unicode 一般カテゴリが記号（`S`）または句読点（`P`）に属し、以下の範囲に含まれる文字:
  - 一般句読点の一部: `—`（`U+2014`）, `―`（`U+2015`）, `‘` `’` `“` `”`（`U+2018`-`U+201D`）, `…`（`U+2026`）, `※`（`U+203B`）
  - CJK の記号および句読点: `U+3000` - `U+303F`（例: `、`, `。`, `（`, `）`, `「`, `」`, `【`, `】`, `〜` など）
  - カタカナ特殊文字: `゠`（`U+30A0`）, `・`（`U+30FB`）
  - 半角・全角形: `U+FF01` - `U+FF65`, `U+FFE0` - `U+FFEE`（例: `！`, `？`, `：`, `；` など）
  - ※絵文字の `〰`（`U+3030`）および `〽`（`U+303D`）もこの範囲に含まれるため禁止対象です。

- **使用可能な文字（例外・対象外）:**
  - 上記の範囲外にある記号（例: `→`, `×`, `℃`, `№`, `★` など）
  - 範囲内であっても記号・句読点カテゴリ以外の文字:
    - 踊り字・記号: `々`（例: `feat: 時々失敗するテストを修正`）, `〆`, `〇`
    - 全角英数字: `Ａ`, `１`（例: `feat: プランＡを追加`）
  - ASCII 記号、一般的な絵文字、長音符（`ー`）

> **Note:** 全角スペース（`U+3000`）はカテゴリ上 `Zs` のため `fullwidth_symbol` ではなく、不可視文字の規則により文中にあれば `invalid_format`、先頭または末尾にあれば `surrounding_whitespace` と判定されます。

## 例

### 有効な例（Valid）

```text
feat: add passkey login
fix(auth): reject expired sessions
feat!: remove legacy API
feat(api)!: change response format
chore(deps): update hono
feat: ログイン機能を追加
feat: add 👩‍💻 mode
feat: 時々失敗するテストを修正
feat: サーバーを追加
fix: resolve #123
```

### 無効な例（Invalid）

- `Feat: add passkey login` — type が大文字（`unsupported_type`）
- `feat(Auth): add passkey login` — scope に大文字（`invalid_scope`）
- `feat(a/b/c): add passkey login` — scope の `/` が複数（`invalid_scope`）
- `feat: Add passkey login` — description が大文字で始まっている（`invalid_description`）
- `feat: 🎉 add passkey login` — description が絵文字で始まっている（`invalid_description`）
- `feat: add passkey login.` — description 末尾にピリオドがある（`invalid_description`）
- `feat: add login；` — 全角セミコロンが含まれている（`fullwidth_symbol`）
- `feat: 対応（暫定）を追加` — 全角括弧が含まれている（`fullwidth_symbol`）
- `add passkey login` — コロンと空白（`: `）がない（`invalid_format`）
- `   ` — 空白のみ（`empty`）

---

このパッケージは、一般的な Conventional Commits 仕様よりも scope の文字種・区切り、description の境界文字、および全角記号の混入に関して厳格に検証します。
