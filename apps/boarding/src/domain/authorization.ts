import { editorKey, editorName } from "./editors.js";

import type { Consent, Editor } from "./editors.js";

export type AuthorizationResult = (
  | { status: "allowed"; reason: "AUTHORIZED" }
  | { status: "not_applicable"; reason: "NO_CONTENT_CHANGES" }
  | {
      status: "waiting";
      reason: "EDITOR_APPROVAL_MISSING" | "TEAM_MAINTAINER_REQUIRED" | "WEBSITE_MEMBER_CONSENT_MISSING";
    }
  | {
      status: "rejected";
      reason:
        | "INVALID_EDITORS"
        | "INVALID_PROFILE"
        | "INITIAL_AUTHOR_NOT_EDITOR"
        | "NON_CONTENT_CHANGE_FORBIDDEN"
        | "AUTHOR_ROOT_CASE_CONFLICT"
        | "COMMIT_IDENTITY_MISMATCH";
    }
) & {
  details?:
    | {
        missing?: { kind: "all" | "one"; editors: string[] } | undefined;
      }
    | undefined;
};

export interface RootAuthorization {
  before: Editor[] | null;
  after: Editor[];
  authorId: number;
  consents: Consent[];
  websiteAddedOrChanged: boolean;
}

export const authorizeRoot = (input: RootAuthorization): AuthorizationResult => {
  const { before, after, authorId, consents, websiteAddedOrChanged } = input;
  const unique = (editors: Editor[]): boolean => new Set(editors.map(editorKey)).size === editors.length;

  if (after.length === 0 || !unique(after) || (before !== null && (before.length === 0 || !unique(before)))) {
    return { status: "rejected", reason: "INVALID_EDITORS" };
  }

  const hasConsent = (
    editor: Editor,
    options: { maintainer?: boolean; actorId?: number; orgMember?: boolean } = {}
  ): boolean =>
    consents.some(
      (consent) =>
        editorKey(consent.editor) === editorKey(editor) &&
        (options.actorId === undefined || consent.actorId === options.actorId) &&
        (!options.maintainer || editor.type === "user" || consent.maintainer) &&
        (!options.orgMember || consent.orgMember)
    );

  if (before === null) {
    if (!after.some((editor) => hasConsent(editor, { actorId: authorId }))) {
      return { status: "rejected", reason: "INITIAL_AUTHOR_NOT_EDITOR" };
    }
  } else {
    const previous = new Set(before.map(editorKey));
    const next = new Set(after.map(editorKey));
    const added = after.filter((editor) => !previous.has(editorKey(editor)));
    const removed = before.filter((editor) => !next.has(editorKey(editor)));
    const missingChange = [...added, ...removed].filter((editor) => !hasConsent(editor, { maintainer: true }));

    if (missingChange.length > 0) {
      return {
        status: "waiting",
        reason: missingChange.some((editor) => editor.type === "team")
          ? "TEAM_MAINTAINER_REQUIRED"
          : "EDITOR_APPROVAL_MISSING",
        details: { missing: { kind: "all", editors: missingChange.map(editorName) } },
      };
    }

    if ((added.length > 0 || removed.length === 0) && !before.some((editor) => hasConsent(editor))) {
      return {
        status: "waiting",
        reason: "EDITOR_APPROVAL_MISSING",
        details: { missing: { kind: "one", editors: before.map(editorName) } },
      };
    }
  }

  if (websiteAddedOrChanged) {
    const editors = before ?? after;
    if (!editors.some((editor) => hasConsent(editor, { orgMember: true }))) {
      return {
        status: "waiting",
        reason: "WEBSITE_MEMBER_CONSENT_MISSING",
        details: { missing: { kind: "one", editors: editors.map(editorName) } },
      };
    }
  }

  return { status: "allowed", reason: "AUTHORIZED" };
};
