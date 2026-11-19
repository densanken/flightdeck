import { describe, expect, it, vi } from "vitest";

import { NotificationUseCaseImpl } from "./impl.js";

import type { NotificationDependencies } from "./dependencies.js";

const blank = { metaYaml: null, metaYml: null, profileYaml: null, profileYml: null };
const setup = () => {
  const dependencies: NotificationDependencies = {
    pullRequest: vi.fn().mockResolvedValue({
      baseSha: "base",
      headSha: "head",
      baseRoots: ["existing"],
      files: [
        { path: "authors/new/meta.yaml" },
        { path: "authors/existing/meta.yaml" },
        { path: "authors/empty/post.md" },
      ],
    }),
    files: vi.fn().mockResolvedValue([{ root: "new", before: blank, after: { ...blank, metaYaml: "meta" } }]),
    readEditors: vi.fn().mockReturnValue([{ type: "user", login: "alice" }]),
    notifyMerged: vi.fn().mockResolvedValue(undefined),
  };
  return { dependencies, usecase: new NotificationUseCaseImpl(dependencies) };
};

describe("登録完了の通知", () => {
  it("新しいメタデータの Editor を取得して通知する", async () => {
    const { dependencies, usecase } = setup();
    await usecase.execute({ number: 3 });
    expect(dependencies.files).toHaveBeenCalledWith("base", "head", ["new"]);
    expect(dependencies.notifyMerged).toHaveBeenCalledWith({
      number: 3,
      roots: [{ name: "new", editors: [{ type: "user", login: "alice" }] }],
    });
  });

  it("メタデータを解析できない場合は Editor 不明で通知する", async () => {
    const { dependencies, usecase } = setup();
    vi.mocked(dependencies.readEditors).mockImplementation(() => {
      throw new Error();
    });
    await usecase.execute({ number: 3 });
    expect(dependencies.notifyMerged).toHaveBeenCalledWith({ number: 3, roots: [{ name: "new", editors: null }] });
  });

  it.each([{ path: "authors/existing/meta.yaml" }, { path: "authors/new/meta.yaml", removed: true }])(
    "既存または削除されたメタデータだけなら取得も通知もしない",
    async (file) => {
      const { dependencies, usecase } = setup();
      vi.mocked(dependencies.pullRequest).mockResolvedValue({
        baseSha: "base",
        headSha: "head",
        baseRoots: ["existing"],
        files: [file],
      });
      await usecase.execute({ number: 3 });
      expect(dependencies.files).not.toHaveBeenCalled();
      expect(dependencies.notifyMerged).not.toHaveBeenCalled();
    }
  );
});
