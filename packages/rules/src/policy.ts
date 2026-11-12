import { normalizeGitHubUrl } from "./naming.js";

export type PolicyKind = "dispatch" | "renovate-stale";
type PolicyResult = "allowed" | "violated" | "undeterminable";
export const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export const classify = (
  authorId: number | null,
  dispatchId: number,
  renovateIds: readonly number[]
): PolicyKind | null => {
  if (authorId === dispatchId) return "dispatch";
  return authorId !== null && renovateIds.includes(authorId) ? "renovate-stale" : null;
};

export const automergeDisabled = (body: string): boolean => {
  const lines = body.split(/\r?\n/).filter((line) => line.includes("**Automerge**: "));
  return lines.length === 1 && (lines[0]?.includes("**Automerge**: Disabled by config.") ?? false);
};

export interface Actor {
  type: string;
  id: number | null;
  login?: string;
}

export type TimelineItem =
  | { kind: "event"; createdAt: string; actor: Actor | null }
  | { kind: "review"; createdAt: string; submittedAt: string | null; actor: Actor | null }
  | { kind: "comment"; createdAt: string; actor: Actor | null; editor: Actor | null; lastEditedAt: string | null }
  | { kind: "commit"; committedAt: string; authorId: number | null; email: string | null }
  | { kind: "other" };

const isHuman = (actor: Actor | null, renovateIds: readonly number[]): boolean =>
  actor?.type === "User" &&
  actor.login?.toLowerCase() !== "ghost" &&
  (actor.id === null || !renovateIds.includes(actor.id));

export const humanActivity = (input: {
  createdAt: string;
  editor: Actor | null;
  lastEditedAt: string | null;
  timeline: TimelineItem[];
  pageCount: number;
  hasPreviousPage: boolean;
  recentCount: number;
  renovateIds: readonly number[];
  now: number;
}): PolicyResult => {
  const cutoff = input.now - STALE_MS;

  const created = Date.parse(input.createdAt);
  if (!Number.isFinite(created)) return "undeterminable";
  if (created > cutoff) return "violated";

  if (
    !Number.isInteger(input.pageCount) ||
    input.pageCount < 0 ||
    input.pageCount > 100 ||
    input.timeline.length !== input.pageCount
  ) {
    return "undeterminable";
  }

  const times: string[] = [];
  if (isHuman(input.editor, input.renovateIds)) {
    if (!input.lastEditedAt) return "undeterminable";

    times.push(input.lastEditedAt);
  }

  for (const item of input.timeline) {
    if (item.kind === "commit") {
      // Bot の commit は author.user が null になるため、noreply の email から数値 ID を読む
      const emailId = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(item.email ?? "")?.[1];
      const id = item.authorId ?? (emailId === undefined ? null : Number(emailId));
      if (id === null || !input.renovateIds.includes(id)) times.push(item.committedAt);
    } else if (item.kind !== "other") {
      if (isHuman(item.actor, input.renovateIds)) {
        times.push(item.createdAt);

        // 過去に書き始めて最近 submit したレビューも最近の操作として数える
        if (item.kind === "review" && item.submittedAt) times.push(item.submittedAt);
      }
      if (item.kind === "comment" && isHuman(item.editor, input.renovateIds)) {
        if (!item.lastEditedAt) return "undeterminable";

        times.push(item.lastEditedAt);
      }
    }
  }

  for (const value of times) {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "undeterminable";
    if (time > cutoff) return "violated";
  }

  if (!Number.isInteger(input.recentCount) || input.recentCount < 0 || input.recentCount > input.pageCount) {
    return "undeterminable";
  }

  // 未取得の項目があり、取得したページがすべて直近なら、未取得の範囲に直近の操作がないと確定できない
  if (input.hasPreviousPage && input.recentCount === input.pageCount) return "violated";

  return "allowed";
};

export interface GitlinkEntry {
  type: string;
  oid: string;
}

interface GitlinkInput {
  source: string;
  submoduleUrl: string | null;
  base: GitlinkEntry | null;
  head: GitlinkEntry | null;
}

export const verifyGitlink = (
  input: GitlinkInput
): input is GitlinkInput & { base: GitlinkEntry; head: GitlinkEntry } =>
  input.base !== null &&
  input.head !== null &&
  input.base.type === "commit" &&
  input.head.type === "commit" &&
  input.base.oid !== input.head.oid &&
  input.submoduleUrl !== null &&
  normalizeGitHubUrl(input.submoduleUrl) === input.source.toLowerCase();

export const verifySourceHistory = (
  sourceComparison: string | null,
  ancestryComparison: string | null
): PolicyResult => {
  if (sourceComparison === null || ancestryComparison === null) return "undeterminable";

  // 更新後の SHA が default branch 上にあり、更新前の SHA がその祖先であること
  return (sourceComparison === "IDENTICAL" || sourceComparison === "BEHIND") && ancestryComparison === "behind"
    ? "allowed"
    : "violated";
};
