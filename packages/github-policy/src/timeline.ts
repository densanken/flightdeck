import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

import { parseResponse } from "./error.js";
import { actor } from "./schema.js";
import { TIMELINE_EVENT_TYPES } from "./timeline-events.js";

import type { Actor, TimelineItem } from "@flightdeck/rules";

export const normalizeActor = (value: v.InferOutput<typeof actor>): Actor | null =>
  value ? { type: value.__typename, id: value.databaseId ?? null, login: value.login } : null;

const eventTypes = new Set<string>(TIMELINE_EVENT_TYPES);

const timedActor = v.object({ createdAt: v.string(), actor });

const comment = v.object({ createdAt: v.string(), author: actor, editor: actor, lastEditedAt: v.nullable(v.string()) });

const review = v.object({ createdAt: v.string(), submittedAt: v.nullable(v.string()), author: actor });

const commit = v.object({
  commit: v.object({
    committedDate: v.string(),
    author: v.nullable(
      v.object({ email: v.nullable(v.string()), user: v.nullable(v.object({ databaseId: v.nullable(githubId) })) })
    ),
  }),
});

export const timelineItem = (node: Record<string, unknown>): TimelineItem => {
  if (node.__typename === "PullRequestCommit") {
    const { commit: value } = parseResponse(commit, node);

    return {
      kind: "commit",
      committedAt: value.committedDate,
      authorId: value.author?.user?.databaseId ?? null,
      email: value.author?.email ?? null,
    };
  }

  if (node.__typename === "IssueComment") {
    const value = parseResponse(comment, node);

    return {
      kind: "comment",
      createdAt: value.createdAt,
      actor: normalizeActor(value.author),
      editor: normalizeActor(value.editor),
      lastEditedAt: value.lastEditedAt,
    };
  }

  if (node.__typename === "PullRequestReview") {
    const value = parseResponse(review, node);

    return {
      kind: "review",
      createdAt: value.createdAt,
      submittedAt: value.submittedAt,
      actor: normalizeActor(value.author),
    };
  }

  if (typeof node.__typename === "string" && eventTypes.has(node.__typename)) {
    const value = parseResponse(timedActor, node);

    return { kind: "event", createdAt: value.createdAt, actor: normalizeActor(value.actor) };
  }

  return { kind: "other" };
};
