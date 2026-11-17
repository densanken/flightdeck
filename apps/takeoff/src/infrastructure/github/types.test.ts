import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  gitHubCheckRunsResponseSchema,
  gitHubCombinedStatusSchema,
  gitHubInstallationReposResponseSchema,
  gitHubWorkflowRunsResponseSchema,
} from "./types.js";

describe("GitHub 応答の件数", () => {
  it.each([
    [gitHubCheckRunsResponseSchema, { check_runs: [] }],
    [gitHubCombinedStatusSchema, { state: "success", statuses: [] }],
    [gitHubInstallationReposResponseSchema, { repositories: [] }],
    [gitHubWorkflowRunsResponseSchema, { workflow_runs: [] }],
  ])("負の値と安全な整数の範囲外を拒否する", (schema, value) => {
    expect(v.safeParse(schema, { ...value, total_count: 0 }).success).toBe(true);
    expect(v.safeParse(schema, { ...value, total_count: -1 }).success).toBe(false);
    expect(v.safeParse(schema, { ...value, total_count: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(v.safeParse(schema, { ...value, total_count: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
});
