import { describe, expect, it } from "vitest";

import { splitRepository } from "./repository.js";

describe("splitRepository", () => {
  it("owner とリポジトリ名を分ける", () => {
    expect(splitRepository("owner/repo")).toEqual({ owner: "owner", name: "repo" });
  });

  it("区切りがない場合はリポジトリ名を空にする", () => {
    expect(splitRepository("owner")).toEqual({ owner: "owner", name: "" });
  });
});
