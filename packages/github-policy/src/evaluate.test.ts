import { describe, expect, it, vi } from "vitest";

import { decide } from "./evaluate.js";

import type { PolicyGateway } from "./evaluate.js";
import type { PolicyPullRequest } from "@flightdeck/rules";

const settings = { dispatchId: 1, renovateIds: [2], botUserId: 3 };
const now = Date.parse("2026-11-10T00:00:00Z");
const pr: PolicyPullRequest = {
  state: "OPEN",
  draft: false,
  body: "**Automerge**: Disabled by config.",
  createdAt: "2026-09-01T00:00:00Z",
  branch: "flightdeck-dispatch/org/source",
  headSha: "new",
  mergeSha: null,
  baseBranch: "main",
  baseOid: "base",
  author: { type: "Bot", id: 1 },
  editor: null,
  lastEditedAt: null,
  headRepositoryId: 1,
  labels: [],
  files: [{ path: "sub", changeType: "MODIFIED" }],
  opinionatedReviews: [],
  reviews: [],
  timeline: [],
  timelinePageCount: 0,
  timelineHasPreviousPage: false,
  recentCount: 0,
  submodules: [{ path: "sub", gitUrl: "https://github.com/org/source.git" }],
  submodulesComplete: true,
  checks: [],
  statuses: [],
};
const gateway = (): PolicyGateway => ({
  configs: vi.fn(() => Promise.resolve([])),
  trees: vi.fn(() => Promise.resolve({ base: { type: "commit", oid: "old" }, head: { type: "commit", oid: "new" } })),
  compare: vi.fn(() => Promise.resolve({ source: "BEHIND", ancestry: "behind" })),
  rules: vi.fn(() => Promise.resolve([])),
});

describe("PR の承認条件", () => {
  it.each([
    ["closed", { state: "CLOSED" }],
    ["対象外 author", { author: { type: "User", id: 10 } }],
  ])("%s の PR は設定を取得しない", async (_name, change) => {
    const client = gateway();

    expect((await decide(client, 1, { ...pr, ...change }, settings, now)).kind).toBe("skip");
    expect(client.configs).not.toHaveBeenCalled();
  });

  it("dispatch の gitlink を CI の完了前に承認する", async () => {
    expect(await decide(gateway(), 1, pr, settings, now)).toEqual({
      kind: "allowed",
      policy: "dispatch",
      headSha: "new",
    });
  });

  it("不正な base 設定で停止し Renovate の opt-out を適用する", async () => {
    const client = gateway();
    vi.mocked(client.configs).mockResolvedValueOnce([
      { path: ".github/flightdeck.yml", text: "autopilot: {unknown: true}" },
    ]);

    expect(await decide(client, 1, pr, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "config_invalid",
    });

    vi.mocked(client.configs).mockResolvedValueOnce([
      { path: ".github/flightdeck.yaml", text: "autopilot: {renovate-stale: false}" },
    ]);

    expect(
      await decide(
        client,
        1,
        {
          ...pr,
          author: { type: "Bot", id: 2 },
        },
        settings,
        now
      )
    ).toMatchObject({
      kind: "violated",
      reasonCode: "renovate_disabled",
    });
  });

  it("設定ファイルが両方存在する場合は判定不能にする", async () => {
    const client = gateway();
    vi.mocked(client.configs).mockResolvedValue([
      { path: ".github/flightdeck.yml", text: "" },
      { path: ".github/flightdeck.yaml", text: "" },
    ]);
    expect(await decide(client, 1, pr, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "config_both_files",
    });
  });

  it("共通ガードと dispatch の違反を拒否する", async () => {
    for (const change of [
      { draft: true },
      { headRepositoryId: 2 },
      { labels: ["AUTOPILOT:SKIP"] },
      { branch: "other" },
      { files: [...pr.files, { path: "extra", changeType: "MODIFIED" }] },
      { files: [{ path: ".github/flightdeck.yaml", changeType: "MODIFIED" }] },
      { opinionatedReviews: [{ id: 4, state: "CHANGES_REQUESTED", author: { type: "User", id: 4 }, commitOid: null }] },
    ]) {
      expect((await decide(gateway(), 1, { ...pr, ...change }, settings, now)).kind).toBe("violated");
    }
  });

  it("Renovate には人間操作の放置期間と CI 成功を要求する", async () => {
    const renovate = {
      ...pr,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };

    expect((await decide(gateway(), 1, renovate, settings, now)).kind).toBe("allowed");
    expect((await decide(gateway(), 1, { ...renovate, createdAt: "2026-11-01T00:00:00Z" }, settings, now)).kind).toBe(
      "violated"
    );
    expect((await decide(gateway(), 1, { ...renovate, body: "**Automerge**: Enabled." }, settings, now)).kind).toBe(
      "violated"
    );
    expect((await decide(gateway(), 1, { ...renovate, checks: [] }, settings, now)).kind).toBe("undeterminable");
    expect(
      (
        await decide(
          gateway(),
          1,
          {
            ...renovate,
            checks: [
              { name: "ci", status: "completed", conclusion: "failure", app: { id: 5, slug: "github-actions" } },
            ],
          },
          settings,
          now
        )
      ).kind
    ).toBe("violated");
  });
});

describe("設定ファイルの改名", () => {
  it.each(["RENAMED", "COPIED"])("base に設定がなくても %s を保留する", async (changeType) => {
    const renovate = {
      ...pr,
      author: { type: "Bot", id: 2 },
      files: [{ path: "renamed.yml", changeType }],
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };
    expect(await decide(gateway(), 1, renovate, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "config_rename_unknown",
    });
  });
  it("改名元が不明でも確定した違反を優先する", async () => {
    const client = gateway();
    const renamed = {
      ...pr,
      author: { type: "Bot", id: 2 },
      files: [{ path: "other.yml", changeType: "RENAMED" }],
      checks: [{ name: "ci", status: "completed", conclusion: "failure", app: { id: 5, slug: "github-actions" } }],
    };

    expect(await decide(client, 1, { ...renamed, headRepositoryId: 2 }, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "fork",
    });
    expect(await decide(client, 1, renamed, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "ci_failed",
    });
    expect(client.rules).not.toHaveBeenCalled();
  });
});

describe("submodule 一覧", () => {
  it("dispatch にだけ完全な submodule 一覧を要求する", async () => {
    const client = gateway();

    expect(await decide(client, 1, { ...pr, submodulesComplete: false }, settings, now)).toMatchObject({
      kind: "undeterminable",
      reasonCode: "submodules_truncated",
    });

    const renovate = {
      ...pr,
      submodulesComplete: false,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };

    expect((await decide(client, 1, renovate, settings, now)).kind).toBe("allowed");
  });
});
describe("設定変更", () => {
  it("設定ファイルの変更を拒否する", async () => {
    const client = gateway();
    for (const path of [".gitmodules", ".github/flightdeck.yml", ".github/flightdeck.yaml"]) {
      expect((await decide(client, 1, { ...pr, files: [{ path, changeType: "MODIFIED" }] }, settings, now)).kind).toBe(
        "violated"
      );
    }
  });
});

describe("取得の順序", () => {
  it("dispatch は設定、tree、source の順に取得する", async () => {
    const client = gateway();
    await decide(client, 1, pr, settings, now);
    expect(vi.mocked(client.configs).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.trees).mock.invocationCallOrder[0] ?? 0
    );
    expect(vi.mocked(client.trees).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.compare).mock.invocationCallOrder[0] ?? 0
    );
    expect(client.rules).not.toHaveBeenCalled();
  });
});

describe("人間の操作による放置期間", () => {
  it.each([
    { actor: { type: "User", id: 7 }, createdAt: "2026-11-09T00:00:00Z", expected: "violated" },
    { actor: { type: "User", id: 7 }, createdAt: "2026-10-10T00:00:00Z", expected: "allowed" },
    { actor: { type: "User", id: 7 }, createdAt: "2026-10-11T00:00:00Z", expected: "allowed" },
    { actor: { type: "User", id: 7 }, createdAt: "2026-10-11T00:00:01Z", expected: "violated" },
    { actor: { type: "Bot", id: 2 }, createdAt: "2026-11-09T00:00:00Z", expected: "allowed" },
  ] as const)("$actor.type の $createdAt の操作は $expected と判定する", async ({ actor, createdAt, expected }) => {
    const renovate: PolicyPullRequest = {
      ...pr,
      createdAt: "2026-10-06T00:00:00Z",
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
      timeline: [{ kind: "event", createdAt, actor }],
      timelinePageCount: 1,
      recentCount: Date.parse(createdAt) > Date.parse("2026-10-11T00:00:00Z") ? 1 : 0,
    };
    const result = await decide(gateway(), 1, renovate, settings, now);
    expect(result.kind).toBe(expected);
    if (result.kind === "violated") expect(result.reasonCode).toBe("human_activity");
  });
});

describe("未取得データと履歴の判定", () => {
  it("未取得の timeline があり取得ページがすべて直近なら違反とする", async () => {
    const renovate: PolicyPullRequest = {
      ...pr,
      author: { type: "Bot", id: 2 },
      timeline: Array.from({ length: 100 }, () => ({ kind: "other" as const })),
      timelinePageCount: 100,
      timelineHasPreviousPage: true,
      recentCount: 100,
    };
    expect(await decide(gateway(), 1, renovate, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "human_activity",
    });
  });

  it.each(["base", "head"] as const)("%s の tree に gitlink がなければ違反とする", async (missing) => {
    const client = gateway();
    vi.mocked(client.trees).mockResolvedValue({
      base: missing === "base" ? null : { type: "commit", oid: "old" },
      head: missing === "head" ? null : { type: "commit", oid: "new" },
    });
    expect(await decide(client, 1, pr, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "invalid_gitlink",
    });
    expect(client.compare).not.toHaveBeenCalled();
  });

  it("source の履歴が一致しなければ違反とする", async () => {
    const client = gateway();
    vi.mocked(client.compare).mockResolvedValue({ source: "AHEAD", ancestry: "behind" });
    expect(await decide(client, 1, pr, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "invalid_source_history",
    });
  });

  it("データ取得失敗を判定結果に丸めず呼び出し元へ伝える", async () => {
    const client = gateway();
    const error = new Error("unavailable");
    vi.mocked(client.trees).mockRejectedValue(error);
    await expect(decide(client, 1, pr, settings, now)).rejects.toBe(error);
  });

  it("GitHub Actions がなくても確定した status 失敗を違反とする", async () => {
    const renovate = { ...pr, author: { type: "Bot", id: 2 }, statuses: [{ context: "external", state: "failure" }] };
    expect(await decide(gateway(), 1, renovate, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "ci_failed",
    });
  });

  it("必須チェックの source が一致しなければ違反とする", async () => {
    const client = gateway();
    const renovate = {
      ...pr,
      author: { type: "Bot", id: 2 },
      checks: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 5, slug: "github-actions" } }],
    };
    vi.mocked(client.rules)
      .mockResolvedValueOnce([{ context: "ci", integrationId: 5 }])
      .mockResolvedValueOnce([{ context: "ci", integrationId: 6 }]);
    expect((await decide(client, 1, renovate, settings, now)).kind).toBe("allowed");
    expect(await decide(client, 1, renovate, settings, now)).toMatchObject({
      kind: "violated",
      reasonCode: "ci_failed",
    });
  });
});
