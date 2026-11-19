import { editorKey } from "./editors.js";
import { mergeCheckbox, mergeLabel, mergeRequested, needsConsentHistory } from "./merge-request.js";

import type { AuthorRoot, Editor, Membership } from "./editors.js";
import type { BodyVersion } from "./merge-request.js";
import type { ChangedFile } from "./paths.js";

export const interventionLabel = "Org による管理介入を実施する（組織メンバーのみ可能）";
export const offboardingLabel = "外部 Editor のオフボーディングを実施する（組織メンバーのみ可能）";

export type ManagementApprovalReason = "INTERVENTION_QUORUM_MISSING" | "OFFBOARDING_APPROVAL_MISSING";
export type ManagementMode = "intervention" | "offboarding";
export type ManagementReason = "INVALID_CHECKBOX" | "HISTORY_UNAVAILABLE" | "NOT_AUTHOR" | "CONFLICT" | "NOT_MEMBER";
export type ManagementRequest = { mode: ManagementMode } | { mode: "none"; reason?: ManagementReason | undefined };

export const needsManagementHistory = (body: string): boolean =>
  [interventionLabel, offboardingLabel].some((label) => mergeCheckbox(body, label) === "checked");

export const needsBodyHistory = (body: string): boolean =>
  mergeCheckbox(body, mergeLabel) === "checked" || needsManagementHistory(body) || needsConsentHistory(body);

export const managementRequest = (
  body: string,
  versions: BodyVersion[] | null,
  authorId: number
): ManagementRequest => {
  const intervention = mergeCheckbox(body, interventionLabel);
  const offboarding = mergeCheckbox(body, offboardingLabel);
  if (intervention === "invalid" || offboarding === "invalid") return { mode: "none", reason: "INVALID_CHECKBOX" };
  if (intervention === "unchecked" && offboarding === "unchecked") return { mode: "none" };
  if (!versions || versions.at(-1)?.body !== body) return { mode: "none", reason: "HISTORY_UNAVAILABLE" };
  if (
    (intervention === "checked" && !mergeRequested(versions, authorId, interventionLabel)) ||
    (offboarding === "checked" && !mergeRequested(versions, authorId, offboardingLabel))
  ) {
    return { mode: "none", reason: "NOT_AUTHOR" };
  }
  if (intervention === "checked" && offboarding === "checked") return { mode: "none", reason: "CONFLICT" };

  return { mode: intervention === "checked" ? "intervention" : "offboarding" };
};

export const memberRequest = (request: ManagementRequest, orgRole: Membership["orgRole"]): ManagementRequest =>
  request.mode !== "none" && orgRole == null ? { mode: "none", reason: "NOT_MEMBER" } : request;

const managementApprovers = (
  memberships: Membership[],
  authorId: number,
  mode: ManagementMode
): (Membership & { orgRole: "admin" | "member" })[] => [
  ...new Map(
    memberships
      .filter(
        (member): member is Membership & { orgRole: "admin" | "member" } =>
          member.person.id !== authorId &&
          member.orgRole != null &&
          (mode === "intervention" || member.orgRole === "admin")
      )
      .map((member) => [member.person.id, member])
  ).values(),
];

export const managementApproval = (
  memberships: Membership[],
  authorId: number,
  mode: ManagementMode
): ManagementApprovalReason | undefined => {
  const approvers = managementApprovers(memberships, authorId, mode);
  if (mode === "intervention" && (approvers.length < 4 || !approvers.some((member) => member.orgRole === "admin"))) {
    return "INTERVENTION_QUORUM_MISSING";
  }
  if (mode === "offboarding" && approvers.length === 0) {
    return "OFFBOARDING_APPROVAL_MISSING";
  }
  return undefined;
};

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
