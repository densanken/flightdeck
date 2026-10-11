import { describe, expect, it } from "vitest";

import { escapeDiscordMarkdownLinkText, safeEmbedLinkUrl } from "./discord-markdown.js";

describe("escapeDiscordMarkdownLinkText", () => {
  it("markdown link 記法の括弧を escape する", () => {
    expect(escapeDiscordMarkdownLinkText("x](https://evil.example)[")).toBe("x\\](https://evil.example)\\[");
  });

  it("改行を空白へ潰して行構造の注入を防ぐ", () => {
    expect(escapeDiscordMarkdownLinkText("ci\n**判定:** merge 可")).toBe("ci \\*\\*判定:\\*\\* merge 可");
  });

  it("強調・コード・取り消し線の記法を escape する", () => {
    expect(escapeDiscordMarkdownLinkText("`code` *em* _u_ ~s~ |sp|")).toBe(
      "\\`code\\` \\*em\\* \\_u\\_ \\~s\\~ \\|sp\\|"
    );
  });
});

describe("safeEmbedLinkUrl", () => {
  it("https URL は括弧を encode して返す", () => {
    expect(safeEmbedLinkUrl("https://ci.example/build(1)")).toBe("https://ci.example/build%281%29");
  });

  it("javascript scheme を拒否する", () => {
    expect(safeEmbedLinkUrl("javascript:alert(1)")).toBeNull();
  });

  it("URL として不正な値を拒否する", () => {
    expect(safeEmbedLinkUrl("not a url")).toBeNull();
  });

  it("制御文字入りの URL は parser の正規化結果を返す", () => {
    // URL parser は tab / newline を除去するため、元の入力ではなく href を使う
    expect(safeEmbedLinkUrl("https://safe.example/pa\nth")).toBe("https://safe.example/path");
  });
});
