import { describe, expect, it, vi } from "vitest";

import { getTitleTypeInputs } from "./title-type-inputs.js";
import { titleTypePolicy } from "../../domain/title-types.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

describe("getTitleTypeInputs", () => {
  const setup = (changedFiles: number, config: unknown) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((url) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.endsWith("/graphql")) return Promise.resolve(json(config));
      if (address.includes("/files?")) {
        const page = Number(new URL(address).searchParams.get("page"));
        const directory = address.includes("/pulls/2/") ? "src" : "docs";
        return Promise.resolve(
          json(
            Array.from({ length: Math.min(100, changedFiles - (page - 1) * 100) }, (_, i) => ({
              filename: `${directory}/${String((page - 1) * 100 + i)}.md`,
            }))
          )
        );
      }
      return Promise.resolve(json({ head: { sha: head }, base: { sha: base }, changed_files: changedFiles }));
    });
    return {
      owner: "owner",
      repo: "repo",
      pullRequestNumber: 1,
      headSha: head,
      baseSha: base,
      installationToken: "token",
      fetchImpl,
      signal: new AbortController().signal,
      logger: { log: vi.fn() },
      deliveryId: "delivery",
      cache: { rules: new Map(), files: new Map(), fallbacks: new Set<string>() },
      remainingInputRequests: () => 100,
    };
  };

  const validConfig = {
    data: {
      repository: {
        yml: { text: "preflight:\n  title-types:\n    - paths: ['docs/**']\n      types: [docs]", isTruncated: false },
        yaml: null,
      },
    },
  };

  it("reads the base SHA config and all file pages, then caches immutable inputs", async () => {
    const input = { ...setup(101, validConfig), changedFiles: 101 };
    const result = await getTitleTypeInputs(input);

    expect(result.files).toHaveLength(101);
    expect(result.rules).toEqual([{ paths: ["docs/**"], types: ["docs"] }]);

    const body = input.fetchImpl.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Missing query body");
    const query = JSON.parse(body) as { variables: { yml: string } };
    expect(query.variables.yml).toBe(`${base}:.github/flightdeck.yml`);

    await getTitleTypeInputs(input);
    expect(input.fetchImpl).toHaveBeenCalledTimes(3);

    const other = await getTitleTypeInputs({ ...input, pullRequestNumber: 2 });
    expect(other.files).toHaveLength(101);
    expect(other.files[0]).toBe("src/0.md");
    expect(input.fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("reloads configuration and files when the base changes without a new head", async () => {
    const input = { ...setup(1, validConfig), changedFiles: 1 };
    await getTitleTypeInputs(input);
    await getTitleTypeInputs({ ...input, baseSha: "c".repeat(40) });

    expect(input.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("falls back for more than 3000 files", async () => {
    const input = setup(3001, validConfig);

    expect(await getTitleTypeInputs(input)).toEqual({
      rules: [{ paths: ["docs/**"], types: ["docs"] }],
      files: [],
      filesComplete: false,
    });
    expect(input.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the PR snapshot without fetching PR details and invalidates the cache when the count changes", async () => {
    const input = setup(1, validConfig);

    expect((await getTitleTypeInputs({ ...input, changedFiles: 0 })).files).toEqual([]);
    expect((await getTitleTypeInputs({ ...input, changedFiles: 1 })).files).toEqual(["docs/0.md"]);
    expect(input.fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      input.fetchImpl.mock.calls.every(([url]) => {
        const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        return address.includes("/graphql") || address.includes("/files?");
      })
    ).toBe(true);
  });

  it("loads all 3000 files at the API limit", async () => {
    const input = setup(3000, validConfig);

    expect((await getTitleTypeInputs(input)).files).toHaveLength(3000);
    expect(input.fetchImpl).toHaveBeenCalledTimes(32);
  });

  it.each([
    { remaining: 2, complete: true },
    { remaining: 1, complete: false },
  ])("compares the required pages with the remaining budget: $remaining", async ({ remaining, complete }) => {
    const input = { ...setup(101, validConfig), changedFiles: 101, remainingInputRequests: () => remaining };
    const result = await getTitleTypeInputs(input);

    expect(result.filesComplete).toBe(complete);
    expect(result.files).toHaveLength(complete ? 101 : 0);
    expect(input.fetchImpl).toHaveBeenCalledTimes(complete ? 3 : 1);
  });

  it("includes the old path of a renamed file without changing the API file count", async () => {
    const input = { ...setup(1, validConfig), changedFiles: 1 };
    const originalFetch = input.fetchImpl.getMockImplementation();

    input.fetchImpl.mockImplementation((url, init) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.includes("/files?")) {
        return Promise.resolve(json([{ filename: "docs/x.md", previous_filename: "src/x.md" }]));
      }
      if (!originalFetch) throw new Error("Missing fetch implementation");
      return originalFetch(url, init);
    });

    const result = await getTitleTypeInputs(input);

    expect(result.files).toEqual(["docs/x.md", "src/x.md"]);
    expect(titleTypePolicy(result)).toMatchObject({ restricted: false });
  });

  it.each([
    { count: 2, files: [{ filename: "docs/a.md" }, { filename: "docs/a.md" }] },
    { count: 1, files: [{ filename: "docs/a.md" }, { filename: "src/b.ts" }] },
  ])("rejects an inconsistent file list instead of using a partial policy", async ({ count, files }) => {
    const input = { ...setup(count, validConfig), changedFiles: count };
    const originalFetch = input.fetchImpl.getMockImplementation();

    input.fetchImpl.mockImplementation((url, init) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.includes("/files?")) return Promise.resolve(json(files));
      if (!originalFetch) throw new Error("Missing fetch implementation");
      return originalFetch(url, init);
    });

    await expect(getTitleTypeInputs(input)).rejects.toThrow();
  });

  it("leaves the reserve intact when there is no budget for configuration or PR details", async () => {
    const input = { ...setup(1, validConfig), remainingInputRequests: () => 0 };

    expect(await getTitleTypeInputs({ ...input, changedFiles: 1 })).toMatchObject({ rules: undefined });
    expect(await getTitleTypeInputs({ ...input, baseSha: undefined })).toMatchObject({ rules: undefined });
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back without spending the reserve when retries use the file budget", async () => {
    let remaining = 3;
    const input = { ...setup(101, validConfig), changedFiles: 101, remainingInputRequests: () => remaining };
    const originalFetch = input.fetchImpl.getMockImplementation();
    let failed = false;

    input.fetchImpl.mockImplementation((url, init) => {
      remaining -= 1;
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.includes("/files?") && !failed) {
        failed = true;
        return Promise.resolve(new Response(null, { status: 503, headers: { "retry-after": "0" } }));
      }
      if (!originalFetch) throw new Error("Missing fetch implementation");
      return originalFetch(url, init);
    });

    expect(await getTitleTypeInputs(input)).toEqual({ rules: undefined, files: [], filesComplete: false });
    expect(remaining).toBe(0);
    expect(input.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses default types when input requests exceed the budget", async () => {
    const input = {
      ...setup(101, validConfig),
      changedFiles: 101,
      remainingInputRequests: () => 1,
    };

    await expect(getTitleTypeInputs(input)).resolves.toEqual({ rules: undefined, files: [], filesComplete: false });
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses a budget fallback across phases for the same PR snapshot", async () => {
    const input = { ...setup(101, validConfig), changedFiles: 101, remainingInputRequests: () => 1 };
    expect((await getTitleTypeInputs(input)).filesComplete).toBe(false);

    const recovered = await getTitleTypeInputs({
      ...input,
      remainingInputRequests: () => 2,
    });

    expect(recovered.filesComplete).toBe(false);
    expect(titleTypePolicy(recovered)).toBeUndefined();
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);

    const changed = await getTitleTypeInputs({
      ...input,
      baseSha: "c".repeat(40),
      remainingInputRequests: () => 2,
    });
    expect(changed.filesComplete).toBe(true);
    expect(changed.files).toHaveLength(101);
  });

  it("does not log when the configuration file is absent", async () => {
    const input = { ...setup(1, { data: { repository: { yml: null, yaml: null } } }), changedFiles: 1 };
    await getTitleTypeInputs(input);

    expect(input.logger.log).not.toHaveBeenCalled();
  });

  it("rejects a base change while loading", async () => {
    const input = setup(1, validConfig);

    await expect(getTitleTypeInputs({ ...input, baseSha: "c".repeat(40) })).rejects.toThrow();
  });

  it("logs invalid configuration and falls back", async () => {
    const input = setup(1, { data: { repository: { yml: { text: "preflight: [", isTruncated: false }, yaml: null } } });

    expect(await getTitleTypeInputs(input)).toEqual({ rules: undefined, files: [], filesComplete: false });
    expect(input.logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({ result: "config_unavailable" }));
  });

  it.each(["draft", "wip"])("logs and falls back for reserved type %s", async (type) => {
    const input = setup(1, {
      data: {
        repository: {
          yml: { text: `preflight:\n  title-types:\n    - paths: ['**']\n      types: [${type}]`, isTruncated: false },
          yaml: null,
        },
      },
    });

    expect(await getTitleTypeInputs(input)).toEqual({ rules: undefined, files: [], filesComplete: false });
    expect(input.logger.log).toHaveBeenCalledWith("warn", expect.objectContaining({ result: "config_unavailable" }));
  });
});
