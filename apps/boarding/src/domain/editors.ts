import type { ChangedFile } from "./paths.js";

export type Editor = { type: "user"; login: string } | { type: "team"; slug: string };

export interface NewAuthorRoot {
  name: string;
  editors: Editor[] | null;
}

export interface ResolvedUser {
  login: string;
  person: Person | null;
}

export interface Person {
  id: number;
  login: string;
}

export interface Membership {
  person: Person;
  orgRole: "admin" | "member" | null | undefined;
  teams: Record<string, "maintainer" | "member" | null>;
}

export interface Consent {
  editor: Editor;
  actorId: number;
  maintainer: boolean;
  orgMember: boolean;
}

export interface AuthorRoot {
  name: string;
  before: Editor[] | null;
  after: Editor[];
  websiteAddedOrChanged: boolean;
}

export const editorName = (editor: Editor): string => (editor.type === "user" ? editor.login : `team:${editor.slug}`);

export const editorKey = (editor: Editor): string => `${editor.type}:${editorName(editor).toLowerCase()}`;

export const uniqueEditors = (roots: AuthorRoot[]): Editor[] => [
  ...new Map(
    roots.flatMap((root) => [...(root.before ?? []), ...root.after]).map((editor) => [editorKey(editor), editor])
  ).values(),
];

// Approve の対象になる、変更前の Editor（新規の Root は変更後の Editor）
export const currentEditors = (roots: AuthorRoot[]): Editor[] => [
  ...new Map(roots.flatMap((root) => root.before ?? root.after).map((editor) => [editorKey(editor), editor])).values(),
];

export const splitEditors = (editors: Editor[]): { users: string[]; teams: string[] } => ({
  users: editors.flatMap((editor) => (editor.type === "user" ? [editor.login] : [])),
  teams: editors.flatMap((editor) => (editor.type === "team" ? [editor.slug] : [])),
});

export const matches = (editor: Editor, membership: Membership): boolean =>
  editor.type === "user"
    ? editorKey(editor) === editorKey({ type: "user", login: membership.person.login })
    : membership.teams[editor.slug.toLowerCase()] === "member" ||
      membership.teams[editor.slug.toLowerCase()] === "maintainer";

export const isOrgMember = (membership: Membership): boolean =>
  membership.orgRole != null || Object.values(membership.teams).some((role) => role != null);

export const websiteCandidate = (membership: Membership, root: AuthorRoot): boolean =>
  root.websiteAddedOrChanged && (root.before ?? root.after).some((editor) => matches(editor, membership));

export const buildConsents = (memberships: Membership[], editors: Editor[]): Consent[] =>
  memberships.flatMap((membership) =>
    editors
      .filter((editor) => matches(editor, membership))
      .map((editor) => ({
        editor,
        actorId: membership.person.id,
        maintainer: editor.type === "team" && membership.teams[editor.slug.toLowerCase()] === "maintainer",
        orgMember: isOrgMember(membership),
      }))
  );

export const changedRoots = (files: ChangedFile[], roots: string[], name: "meta" | "profile"): string[] =>
  roots.filter((root) =>
    files.some((file) =>
      [file.path, file.previousPath].some(
        (path) => path === `authors/${root}/${name}.yaml` || path === `authors/${root}/${name}.yml`
      )
    )
  );

export interface Review {
  reviewerId: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED" | "PENDING";
  commitSha: string | null;
  submittedAt: string;
}

export const approvedReviewers = (reviews: Review[], headSha: string, authorId: number): number[] => {
  const latest = new Map<number, Review>();
  const invalidDates = new Set<number>();

  for (const review of reviews) {
    if (review.reviewerId === authorId || review.state === "PENDING" || review.state === "COMMENTED") continue;

    const time = Date.parse(review.submittedAt);
    if (!Number.isFinite(time)) {
      invalidDates.add(review.reviewerId);
      continue;
    }

    const previous = latest.get(review.reviewerId);
    if (!previous || time > Date.parse(previous.submittedAt)) latest.set(review.reviewerId, review);
    else if (time === Date.parse(previous.submittedAt)) {
      latest.set(review.reviewerId, { ...review, state: "DISMISSED" });
    }
  }

  return [...latest.values()]
    .filter(
      (review) => !invalidDates.has(review.reviewerId) && review.state === "APPROVED" && review.commitSha === headSha
    )
    .map((review) => review.reviewerId);
};

export const approvedPeople = (
  reviews: (Review & { login: string; isBot?: boolean | undefined })[],
  headSha: string,
  authorId: number
): Person[] => {
  const approved = new Set(approvedReviewers(reviews, headSha, authorId));
  return [
    ...new Map(
      reviews
        .filter((review) => !review.isBot && approved.has(review.reviewerId))
        .map((review) => [review.reviewerId, { id: review.reviewerId, login: review.login }])
    ).values(),
  ];
};
