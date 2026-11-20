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
    current: vi.fn().mockResolvedValue({ state: "CLOSED" }),
    closeComment: vi.fn().mockResolvedValue(undefined),
    notifyMerged: vi.fn().mockResolvedValue(undefined),
  };
  return { dependencies, usecase: new NotificationUseCaseImpl(dependencies) };
};

describe("登録完了の通知", () => {
  it("Merge 済みなら、コメントを更新してから通知する", async () => {
    const { dependencies, usecase } = setup();
    await usecase.execute({ number: 3, merged: true });
    expect(dependencies.closeComment).toHaveBeenCalledWith({ number: 3, merged: true });
    expect(vi.mocked(dependencies.closeComment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.pullRequest).mock.invocationCallOrder[0] ?? 0
    );
  });

  it("Merge せずに閉じた場合は、コメントだけを更新する", async () => {
    const { dependencies, usecase } = setup();
    await usecase.execute({ number: 3, merged: false });
    expect(dependencies.closeComment).toHaveBeenCalledWith({ number: 3, merged: false });
    expect(dependencies.pullRequest).not.toHaveBeenCalled();
    expect(dependencies.notifyMerged).not.toHaveBeenCalled();
  });

  it("Merge せずに閉じた PR が再び開かれていたら、コメントを更新しない", async () => {
    const { dependencies, usecase } = setup();
    vi.mocked(dependencies.current).mockResolvedValue({ state: "OPEN" });
    await usecase.execute({ number: 3, merged: false });
    expect(dependencies.current).toHaveBeenCalledWith(3);
    expect(dependencies.closeComment).not.toHaveBeenCalled();
  });

  it("Merge 済みなら、状態を確認せずにコメントを更新する", async () => {
    const { dependencies, usecase } = setup();
    vi.mocked(dependencies.current).mockResolvedValue({ state: "OPEN" });
    await usecase.execute({ number: 3, merged: true });
    expect(dependencies.current).not.toHaveBeenCalled();
    expect(dependencies.closeComment).toHaveBeenCalledWith({ number: 3, merged: true });
  });

  it("コメントの更新に失敗したら通知の取得に進まない", async () => {
    const { dependencies, usecase } = setup();
    vi.mocked(dependencies.closeComment).mockRejectedValue(new Error("failed"));
    await expect(usecase.execute({ number: 3, merged: true })).rejects.toThrow("failed");
    expect(dependencies.pullRequest).not.toHaveBeenCalled();
  });

  it("新しいメタデータの Editor を取得して通知する", async () => {
    const { dependencies, usecase } = setup();
    await usecase.execute({ number: 3, merged: true });
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
    await usecase.execute({ number: 3, merged: true });
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
      await usecase.execute({ number: 3, merged: true });
      expect(dependencies.files).not.toHaveBeenCalled();
      expect(dependencies.notifyMerged).not.toHaveBeenCalled();
    }
  );
});
