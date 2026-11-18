import { describe, expect, it, vi } from "vitest";

import { GitHubMerge } from "./merge.js";
import { GitHubRequest } from "./request.js";

const input = { number: 3, headSha: "head" };
const setup = (status: number) => {
  const fetcher = vi
    .fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValue(Response.json({ merged: status === 200 }, { status }));
  const logger = { log: vi.fn() };
  return {
    fetcher,
    logger,
    gateway: new GitHubMerge({ request: new GitHubRequest(fetcher), getToken: () => Promise.resolve("token"), logger }),
  };
};

describe("GitHubMerge", () => {
  it("評価した SHA で Squash Merge する", async () => {
    const { fetcher, gateway } = setup(200);
    await expect(gateway.write(input)).resolves.toBe("merged");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body as string)).toEqual({ sha: "head", merge_method: "squash" });
    expect(fetcher.mock.calls[0]?.[1].method).toBe("PUT");
  });

  it.each([403, 405, 422])("拒否 %i を記録し再試行しない", async (status) => {
    const { gateway, logger } = setup(status);
    await expect(gateway.write(input)).resolves.toBe("rejected");
    expect(logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({ status }));
  });

  it("競合は変更として終了する", async () => {
    await expect(setup(409).gateway.write(input)).resolves.toBe("changed");
  });

  it("他の API エラーは再試行可能にする", async () => {
    await expect(setup(500).gateway.write(input)).rejects.toThrow();
  });
});
