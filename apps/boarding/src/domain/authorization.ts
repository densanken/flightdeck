import { editorKey } from "./editors.js";

import type { Consent, Editor } from "./editors.js";
import type { ManagementApprovalReason, ManagementMode, OffboardingTargetReason } from "./management.js";

export type AuthorizationResult = (
  | { status: "allowed"; reason: "AUTHORIZED" }
  | { status: "not_applicable"; reason: "NO_CONTENT_CHANGES" }
  | {
      status: "waiting";
      reason:
        | "EDITOR_APPROVAL_MISSING"
        | "TEAM_MAINTAINER_REQUIRED"
        | "WEBSITE_MEMBER_CONSENT_MISSING"
        | "CONSENT_MISSING"
        | ManagementApprovalReason;
    }
  | {
      status: "rejected";
      reason:
        | "INVALID_EDITORS"
        | "INVALID_PROFILE"
        | "INITIAL_AUTHOR_NOT_EDITOR"
        | "NON_CONTENT_CHANGE_FORBIDDEN"
        | "AUTHOR_ROOT_CASE_CONFLICT"
        | "COMMIT_IDENTITY_MISMATCH"
        | OffboardingTargetReason;
    }
) & {
  details?:
    | {
        missing?: { kind: "all" | "one"; editors: Editor[] } | undefined;
      }
    | undefined;
};

export interface RootAuthorization {
  before: Editor[] | null;
  after: Editor[];
  authorId: number;
  consents: Consent[];
  websiteAddedOrChanged: boolean;
  mode?: ManagementMode | undefined;
}

const hasConsent = (
  editor: Editor,
  consents: Consent[],
  options: { maintainer?: boolean; actorId?: number; orgMember?: boolean }
): boolean =>
  consents.some(
    (consent) =>
      editorKey(consent.editor) === editorKey(editor) &&
      (options.actorId === undefined || consent.actorId === options.actorId) &&
      (!options.maintainer || editor.type === "user" || consent.maintainer) &&
      (!options.orgMember || consent.orgMember)
  );

const previousConsentResult = (
  before: Editor[],
  next: Set<string>,
  change: { added: Editor[]; removed: Editor[] },
  consents: Consent[],
  mode: ManagementMode | undefined
): AuthorizationResult | undefined => {
  const previousEditors = mode === "offboarding" ? before.filter((editor) => next.has(editorKey(editor))) : before;
  const required =
    mode === "offboarding"
      ? change.added.length > 0 && previousEditors.length > 0
      : mode !== "intervention" && (change.added.length > 0 || change.removed.length === 0);

  if (!required || previousEditors.some((editor) => hasConsent(editor, consents, {}))) return undefined;

  return {
    status: "waiting",
    reason: "EDITOR_APPROVAL_MISSING",
    details: { missing: { kind: "one", editors: previousEditors } },
  };
};

const editorChangeResult = (
  before: Editor[],
  after: Editor[],
  consents: Consent[],
  mode: ManagementMode | undefined
): AuthorizationResult | undefined => {
  const previous = new Set(before.map(editorKey));
  const next = new Set(after.map(editorKey));
  const added = after.filter((editor) => !previous.has(editorKey(editor)));
  const removed = before.filter((editor) => !next.has(editorKey(editor)));
  const missingRemoved = (mode ? [] : removed).filter((editor) => !hasConsent(editor, consents, { maintainer: true }));

  if (missingRemoved.length > 0) {
    return {
      status: "waiting",
      reason: missingRemoved.some((editor) => editor.type === "team")
        ? "TEAM_MAINTAINER_REQUIRED"
        : "EDITOR_APPROVAL_MISSING",
      details: { missing: { kind: "all", editors: missingRemoved } },
    };
  }

  return previousConsentResult(before, next, { added, removed }, consents, mode);
};

export const authorizeRoot = (input: RootAuthorization): AuthorizationResult => {
  const { before, after, authorId, consents, websiteAddedOrChanged, mode } = input;
  const unique = (editors: Editor[]): boolean => new Set(editors.map(editorKey)).size === editors.length;

  if (after.length === 0 || !unique(after) || (before !== null && (before.length === 0 || !unique(before)))) {
    return { status: "rejected", reason: "INVALID_EDITORS" };
  }

  if (before === null) {
    if (!after.some((editor) => hasConsent(editor, consents, { actorId: authorId }))) {
      return { status: "rejected", reason: "INITIAL_AUTHOR_NOT_EDITOR" };
    }
  } else {
    const result = editorChangeResult(before, after, consents, mode);
    if (result) return result;
  }

  if (websiteAddedOrChanged) {
    const editors = before ?? after;
    if (!editors.some((editor) => hasConsent(editor, consents, { orgMember: true }))) {
      return {
        status: "waiting",
        reason: "WEBSITE_MEMBER_CONSENT_MISSING",
      };
    }
  }

  return { status: "allowed", reason: "AUTHORIZED" };
};

export interface CommitIdentity {
  sha: string;
  authorId: number | null;
  authorEmail?: string | null | undefined;
  committerId: number | null;
  committerLogin: string | null;
  signature: { isValid: boolean; wasSignedByGitHub: boolean } | null;
}

export const invalidCommitIdentities = (commits: CommitIdentity[], pullRequestAuthorId: number): CommitIdentity[] =>
  commits.filter((commit) => {
    if (commit.authorId !== pullRequestAuthorId) return true;
    if (commit.committerId === pullRequestAuthorId) return false;

    return !(
      commit.committerId !== null &&
      commit.committerLogin?.toLowerCase() === "web-flow" &&
      commit.signature?.isValid === true &&
      commit.signature.wasSignedByGitHub
    );
  });
