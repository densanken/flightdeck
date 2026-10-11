import { beforeEach, describe, expect, it, vi } from "vitest";

import { once, pullRequestsKey, resetSingleFlight } from "./single-flight.js";

beforeEach(() => {
  resetSingleFlight();
});

describe("once", () => {
  it("同じ key の実行中の読み込みを 1 本にまとめる", async () => {
    const load = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("value");
          }, 10);
        })
    );

    const results = await Promise.all([
      once("repository_index", load),
      once("repository_index", load),
      once("repository_index", load),
    ]);

    expect(results).toEqual(["value", "value", "value"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("key が異なる読み込みはまとめない", async () => {
    const load = vi.fn().mockResolvedValue("value");

    await Promise.all([once(pullRequestsKey("repo-1"), load), once(pullRequestsKey("repo-2"), load)]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("完了した読み込みは次の呼び出しで読み直す", async () => {
    const load = vi.fn().mockResolvedValue("value");

    await once("repository_index", load);
    await once("repository_index", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("失敗した読み込みも取り除き、次の呼び出しで再試行できる", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("value");

    await expect(once("repository_index", load)).rejects.toThrow("boom");
    await expect(once("repository_index", load)).resolves.toBe("value");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
