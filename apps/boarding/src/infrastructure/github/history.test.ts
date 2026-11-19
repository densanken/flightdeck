import { describe, expect, it, vi } from "vitest";

import { GitHubBodyHistory } from "./history.js";
import { GitHubRequest } from "./request.js";

const createdAt = "2026-01-01T00:00:00Z";
const pageInfo = { hasNextPage: false };
const initial = { diff: "最初", editedAt: createdAt, deletedAt: null, editor: { __typename: "User", databaseId: 1 } };
const latest = {
  diff: "現在",
  editedAt: "2026-01-02T00:00:00Z",
  deletedAt: null,
  editor: { __typename: "User", databaseId: 1 },
};
const pr = {
  body: "現在",
  createdAt,
  lastEditedAt: latest.editedAt,
  userContentEdits: { totalCount: 2, pageInfo, nodes: [latest, initial] },
};
const setup = (value: unknown) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { repository: { pullRequest: value } } }));
  const gateway = new GitHubBodyHistory({
    request: new GitHubRequest(fetcher),
    getToken: () => Promise.resolve("token"),
  });
  return { gateway, fetcher };
};
const input = { number: 1, body: "現在", authorId: 1 };

describe("GitHubBodyHistory", () => {
  it("評価用の予算を 23 回消費したら履歴とトークンの通信を行わない", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    const request = new GitHubRequest(fetcher);
    const evaluationRequest = request.withLimit(23);
    for (const _index of Array.from({ length: 23 })) {
      await request.call({ method: "GET", path: "/test", token: "token" });
    }
    const getToken = vi.fn().mockImplementation(async () => {
      await request.call({ method: "GET", path: "/token", token: "token" });
      return "token";
    });
    const gateway = new GitHubBodyHistory({ request: evaluationRequest, getToken });
    await expect(gateway.versions(input)).rejects.toMatchObject({ code: "SUBREQUEST_LIMIT" });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(23);
    await request.call({ method: "GET", path: "/write", token: "token" });
    expect(fetcher).toHaveBeenCalledTimes(24);
  });

  it("編集がなければ現在の本文を PR 作成者の版とする", async () => {
    const { gateway } = setup({ ...pr, lastEditedAt: null, userContentEdits: { totalCount: 0, pageInfo, nodes: [] } });
    await expect(gateway.versions(input)).resolves.toEqual([{ body: "現在", editorId: 1 }]);
  });

  it("編集履歴を古い順に並べて本文と編集者を取得する", async () => {
    const middle = { ...latest, diff: "途中", editor: { __typename: "User", databaseId: 2 } };
    const { gateway } = setup({
      ...pr,
      userContentEdits: { totalCount: 3, pageInfo, nodes: [latest, middle, initial] },
    });
    await expect(gateway.versions(input)).resolves.toEqual([
      { body: "最初", editorId: 1 },
      { body: "途中", editorId: 2 },
      { body: "現在", editorId: 1 },
    ]);
  });

  it.each([
    ["履歴の件数が一致しない", { totalCount: 101 }],
    ["次のページがある", { pageInfo: { hasNextPage: true } }],
    ["履歴が取得できない", null],
    ["削除された版がある", { nodes: [{ ...latest, deletedAt: "2026-01-03T00:00:00Z" }, initial] }],
    ["本文がない", { nodes: [{ ...latest, diff: null }, initial] }],
    ["編集者がいない", { nodes: [{ ...latest, editor: null }, initial] }],
    ["編集者が User でない", { nodes: [{ ...latest, editor: { __typename: "Bot", databaseId: 1 } }, initial] }],
    ["編集者の ID がない", { nodes: [{ ...latest, editor: { __typename: "User", databaseId: null } }, initial] }],
    ["作成時の版がない", { nodes: [latest, { ...initial, editedAt: "2026-01-01T00:00:01Z" }] }],
    [
      "作成時の編集者が PR 作成者と異なる",
      { nodes: [latest, { ...initial, editor: { __typename: "User", databaseId: 2 } }] },
    ],
    ["最新の版が現在の本文と異なる", { nodes: [{ ...latest, diff: "古い本文" }, initial] }],
  ])("%s場合は履歴を使わない", async (_label, change) => {
    const history = change === null ? null : { totalCount: 2, pageInfo, nodes: [latest, initial], ...change };
    await expect(setup({ ...pr, userContentEdits: history }).gateway.versions(input)).resolves.toBeNull();
  });

  it("取得した現在の本文が評価時と異なれば履歴を使わない", async () => {
    await expect(setup({ ...pr, body: "変更後" }).gateway.versions(input)).resolves.toBeNull();
  });
});
