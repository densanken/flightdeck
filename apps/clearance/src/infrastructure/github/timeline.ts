import { z } from "zod";

import { parseResponse } from "./error.js";
import { actor } from "./schema.js";
import { TIMELINE_EVENT_TYPES } from "./timeline-events.js";

import type { Actor, TimelineItem } from "@flightdeck/rules";

export const normalizeActor = (value: z.output<typeof actor>): Actor | null =>
  value ? { type: value.__typename, id: value.databaseId ?? null, login: value.login } : null;

const eventTypes = new Set<string>(TIMELINE_EVENT_TYPES);

const timedActor = z.object({ createdAt: z.string(), actor });

const comment = z.object({ createdAt: z.string(), author: actor, editor: actor, lastEditedAt: z.string().nullable() });

const review = z.object({ createdAt: z.string(), submittedAt: z.string().nullable(), author: actor });

const commit = z.object({
  commit: z.object({
    committedDate: z.string(),
    author: z
      .object({ email: z.string().nullable(), user: z.object({ databaseId: z.number().nullable() }).nullable() })
      .nullable(),
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
