import { describe, expect, it, vi } from "vitest";

import { GitHubComment } from "./comment.js";
import { GitHubRequest } from "./request.js";

const ref = { number: 1, baseSha: "base", headSha: "head", body: "<!-- boarding:authorization -->\n本文" };
const existing = { id: 12, body: "<!-- boarding:authorization -->\nold", user: { id: 10 } };
const setup = (comments: unknown[]) => {
  const fetcher = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json(comments))
    .mockResolvedValueOnce(Response.json({ id: 12, body: ref.body, user: { id: 10 } }));
  const verify = vi.fn().mockResolvedValue(undefined);
  return {
    fetcher,
    verify,
    gateway: new GitHubComment({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
      botUserId: 10,
      verify,
    }),
  };
};

describe("GitHubComment", () => {
  it("App 自身の管理コメントを更新する", async () => {
    const { gateway, fetcher, verify } = setup([existing]);
    await gateway.write(ref);
    expect(verify).toHaveBeenCalledWith(1, "base", "head");
    expect(fetcher.mock.calls[1]?.[1].method).toBe("PATCH");
  });

  it("最初のページで管理コメントが見つかれば後続ページを取得しない", async () => {
    const comments = [
      existing,
      ...Array.from({ length: 99 }, (_, index) => ({ id: index + 20, body: "other", user: { id: 20 } })),
    ];
    const { gateway, fetcher } = setup(comments);
    await gateway.write(ref);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1].method).toBe("PATCH");
  });

  it("2 ページ目で管理コメントが見つかれば上限に達しても更新する", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: index + 20, body: "other", user: { id: 20 } }));
    const { gateway, fetcher } = setup([]);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json(others))
      .mockResolvedValueOnce(Response.json([existing, ...others.slice(0, 99)]))
      .mockResolvedValueOnce(Response.json({ id: 12, body: ref.body, user: { id: 10 } }));
    await gateway.write(ref);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]?.[1].method).toBe("PATCH");
  });

  it("上限まで管理コメントが見つからなければ失敗する", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: index + 20, body: "other", user: { id: 20 } }));
    const { gateway, fetcher } = setup([]);
    fetcher.mockReset().mockResolvedValueOnce(Response.json(others)).mockResolvedValueOnce(Response.json(others));
    await expect(gateway.write(ref)).rejects.toMatchObject({ code: "SUBREQUEST_LIMIT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("他人の同じマーカーのコメントは更新しない", async () => {
    const { gateway, fetcher } = setup([{ ...existing, user: { id: 20 } }]);
    await gateway.write(ref);
    expect(fetcher.mock.calls[1]?.[1].method).toBe("POST");
  });

  it("更新結果が異なるコメントなら失敗する", async () => {
    const { gateway, fetcher } = setup([existing]);
    fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json([existing]))
      .mockResolvedValueOnce(Response.json({ ...existing, id: 13, body: ref.body }));
    await expect(gateway.write(ref)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("複数の管理コメントがある場合は変更しない", async () => {
    const { gateway, fetcher } = setup([existing, { ...existing, id: 13 }]);
    await expect(gateway.write(ref)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("管理コメントがあれば Open の確認なしで更新する", async () => {
    const { gateway, fetcher, verify } = setup([existing]);
    await gateway.updateExisting({ number: 1, body: ref.body });
    expect(verify).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[1]?.[1].method).toBe("PATCH");
  });

  it("管理コメントがなければ作らない", async () => {
    const { gateway, fetcher } = setup([{ ...existing, user: { id: 20 } }]);
    await gateway.updateExisting({ number: 1, body: ref.body });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("管理コメントが複数ある場合は更新しない", async () => {
    const { gateway, fetcher } = setup([existing, { ...existing, id: 13 }]);
    await expect(gateway.updateExisting({ number: 1, body: ref.body })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
