import { describe, expect, it, vi } from "vitest";

import { GitHubApprove } from "./approve.js";
import { GitHubRequest } from "./request.js";

const ref = { number: 1, baseSha: "base", headSha: "head" };
const setup = () => {
  const fetcher = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValue(Response.json({ user: { id: 10 }, state: "APPROVED", commit_id: "head" }));
  const verify = vi.fn().mockResolvedValue(undefined);
  return {
    fetcher,
    verify,
    gateway: new GitHubApprove({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
      botUserId: 10,
      verify,
    }),
  };
};

describe("GitHubApprove", () => {
  it("SHA を照合して承認を作成する", async () => {
    const { gateway, fetcher, verify } = setup();
    await gateway.write(ref);
    expect(verify).toHaveBeenCalledWith(1, "base", "head");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toMatchObject({
      event: "APPROVE",
      commit_id: "head",
    });
  });

  it("作成結果が別の HEAD なら失敗する", async () => {
    const { gateway, fetcher } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ user: { id: 10 }, state: "APPROVED", commit_id: "other" }));
    await expect(gateway.write(ref)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("書き込み直前の SHA が変わったら承認しない", async () => {
    const { gateway, fetcher, verify } = setup();
    verify.mockRejectedValue(new Error("changed"));
    await expect(gateway.write(ref)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
