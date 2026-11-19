import { editorKey } from "./editors.js";

import type { AuthorRoot, Editor, Membership } from "./editors.js";
import type { ManagementMode } from "./management.js";
import type { ChangedFile } from "./paths.js";

export interface MetaKeys {
  before: string[] | null;
  after: string[] | null;
}

type OffboardingChangeReason = "OFFBOARDING_INVALID_CHANGES";
export type OffboardingTargetReason = OffboardingChangeReason | "OFFBOARDING_INVALID_TARGET";

export const removedEditors = (roots: AuthorRoot[]): Editor[] =>
  roots.flatMap(({ before, after }) => {
    const remaining = new Set(after.map(editorKey));
    return (before ?? []).filter((editor) => !remaining.has(editorKey(editor)));
  });

export const offboardingChangeViolation = (
  files: ChangedFile[],
  metaKeys: MetaKeys[]
): OffboardingChangeReason | undefined => {
  if (
    files.length === 0 ||
    !files.every((file) =>
      [file.path, file.previousPath].every((path) => path === undefined || /^authors\/[^/]+\/meta\.ya?ml$/.test(path))
    ) ||
    metaKeys.length === 0 ||
    metaKeys.some(({ before, after }) => [before, after].some((keys) => keys?.length !== 1 || keys[0] !== "editors"))
  ) {
    return "OFFBOARDING_INVALID_CHANGES";
  }
  return undefined;
};

export const offboardingTargetViolation = (
  roots: AuthorRoot[],
  memberships: Membership[]
): OffboardingTargetReason | undefined => {
  const targets = removedEditors(roots);
  if (roots.some((root) => root.before === null) || targets.length === 0) return "OFFBOARDING_INVALID_CHANGES";
  if (targets.some((editor) => editor.type === "team") || memberships.some((member) => member.orgRole !== null)) {
    return "OFFBOARDING_INVALID_TARGET";
  }
  return undefined;
};

export const rootManagementMode = (root: AuthorRoot, mode: ManagementMode | undefined): ManagementMode | undefined =>
  mode === "offboarding" && removedEditors([root]).length === 0 ? undefined : mode;
