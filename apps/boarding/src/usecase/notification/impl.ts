import { newAuthorRoots } from "../../domain/paths.js";

import type { MergedPullRequest, NotificationDependencies } from "./dependencies.js";
import type { NotificationUseCase } from "./interface.js";
import type { Editor } from "../../domain/editors.js";
import type { RootFiles } from "../evaluate/dependencies.js";

export class NotificationUseCaseImpl implements NotificationUseCase {
  constructor(private readonly dependencies: NotificationDependencies) {}

  async execute(input: { number: number; merged: boolean }): Promise<void> {
    // Merge せずに閉じた PR が再試行の間に再び開かれたら、再評価のコメントを上書きしない
    if (input.merged || (await this.dependencies.current(input.number)).state !== "OPEN") {
      // 通知の取得に失敗して再試行になっても、コメントは同じ本文で上書きされる
      await this.dependencies.closeComment(input);
    }
    if (!input.merged) return;

    const pr = await this.dependencies.pullRequest(input.number);
    const roots = await this.findRoots(pr);
    if (roots.length > 0) await this.dependencies.notifyMerged({ number: input.number, roots });
  }

  private async findRoots(pr: MergedPullRequest) {
    const names = newAuthorRoots(pr.files, pr.baseRoots);
    if (names.length === 0) return [];

    const files = await this.dependencies.files(pr.baseSha, pr.headSha, names);

    return files.map(({ root, after }) => ({ name: root, editors: this.readEditors(after) }));
  }

  private readEditors(files: RootFiles): Editor[] | null {
    try {
      return this.dependencies.readEditors(files);
    } catch {
      return null;
    }
  }
}
