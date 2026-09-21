import { describe, expect, it } from "vitest";

import { parsePullRequestWebhookPayload } from "./payload.js";

const payload = (): Record<string, unknown> => ({
  action: "edited",
  before: "previous-sha",
  changes: { title: { from: "feat: old title" } },
  installation: { id: 42 },
  repository: { name: "repo", owner: { login: "owner" } },
  pull_request: {
    number: 7,
    title: "feat: new title",
    head: { sha: "abc123" },
    user: { login: "author", type: "User" },
    assignees: [{ login: "reviewer" }],
  },
});

describe("parsePullRequestWebhookPayload", () => {
  it("title, head SHA, タイトル変更の marker を含む payload を parse する", () => {
    expect(parsePullRequestWebhookPayload(payload())).toEqual({
      action: "edited",
      before: "previous-sha",
      changes: { title: { from: "feat: old title" } },
      installation: { id: 42 },
      repository: { name: "repo", owner: { login: "owner" } },
      pullRequest: {
        number: 7,
        title: "feat: new title",
        head: { sha: "abc123" },
        user: { login: "author", type: "User" },
        assignees: [{ login: "reviewer" }],
      },
    });
  });

  it("title 以外の編集を title の変更と区別する", () => {
    const value = payload();
    value.changes = { body: { from: "old body" } };

    expect(parsePullRequestWebhookPayload(value)).toMatchObject({ action: "edited" });
    expect(parsePullRequestWebhookPayload(value)?.changes).toBeUndefined();
  });

  it.each([
    [
      "title が無い payload",
      (value: Record<string, unknown>) => delete (value.pull_request as Record<string, unknown>).title,
    ],
    [
      "head SHA が無い payload",
      (value: Record<string, unknown>) => delete (value.pull_request as Record<string, unknown>).head,
    ],
    ["changes.title の形式が不正な payload", (value: Record<string, unknown>) => (value.changes = { title: "old" })],
    ["before が空文字の payload", (value: Record<string, unknown>) => (value.before = "")],
  ])("%s を拒否する", (_label, mutate) => {
    const value = payload();
    mutate(value);
    expect(parsePullRequestWebhookPayload(value)).toBeNull();
  });

  it.each<[string, (value: Record<string, unknown>) => void]>([
    [
      "assignees が配列でない payload",
      (value) => {
        (value.pull_request as Record<string, unknown>).assignees = "x";
      },
    ],
    [
      "login の無い assignee を含む payload",
      (value) => {
        (value.pull_request as Record<string, unknown>).assignees = [{}];
      },
    ],
    [
      "installation id が 0 の payload",
      (value) => {
        (value.installation as Record<string, unknown>).id = 0;
      },
    ],
    [
      "installation id が小数の payload",
      (value) => {
        (value.installation as Record<string, unknown>).id = 1.5;
      },
    ],
    [
      "repository の owner が無い payload",
      (value) => {
        delete (value.repository as Record<string, unknown>).owner;
      },
    ],
    [
      "owner login が空文字の payload",
      (value) => {
        ((value.repository as Record<string, unknown>).owner as Record<string, unknown>).login = "";
      },
    ],
    [
      "PR 番号が 0 の payload",
      (value) => {
        (value.pull_request as Record<string, unknown>).number = 0;
      },
    ],
    [
      "user type が空文字の payload",
      (value) => {
        ((value.pull_request as Record<string, unknown>).user as Record<string, unknown>).type = "";
      },
    ],
    [
      "head SHA が空文字の payload",
      (value) => {
        ((value.pull_request as Record<string, unknown>).head as Record<string, unknown>).sha = "";
      },
    ],
    [
      "action が文字列でない payload",
      (value) => {
        value.action = 5;
      },
    ],
  ])("%s を拒否する", (_label, mutate) => {
    const value = payload();
    mutate(value);
    expect(parsePullRequestWebhookPayload(value)).toBeNull();
  });

  it.each([null, [], "text", 42])("record ではない payload %j を拒否する", (value) => {
    expect(parsePullRequestWebhookPayload(value)).toBeNull();
  });
});
