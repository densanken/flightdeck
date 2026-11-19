import type { Editor, NewAuthorRoot } from "../../domain/editors.js";
import type { ChangedFile } from "../../domain/paths.js";
import type { RootFiles, RootFilesPair } from "../evaluate/dependencies.js";

export interface MergedPullRequest {
  baseSha: string;
  headSha: string;
  baseRoots: string[];
  files: ChangedFile[];
}

export interface NotificationDependencies {
  pullRequest: (number: number) => Promise<MergedPullRequest>;
  files: (baseSha: string, headSha: string, roots: string[]) => Promise<RootFilesPair[]>;
  readEditors: (files: RootFiles) => Editor[] | null;
  closeComment: (input: { number: number; merged: boolean }) => Promise<void>;
  notifyMerged: (input: { number: number; roots: NewAuthorRoot[] }) => Promise<void>;
}
