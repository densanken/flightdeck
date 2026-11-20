import { CONFIG_PATHS } from "@flightdeck/rules";
import * as v from "valibot";

import { GITHUB_API_BASE_URL } from "./request.js";
import { logTitleInputWarning, TitleInputBudgetExceededError, titleInputRequest } from "./title-input-request.js";
import { SubrequestBudgetExceededError } from "../../errors.js";
import { readTitleTypeRules } from "../config/parse.js";

import type { ResolvedTitleInputRequest } from "./title-input-request.js";
import type { TitleTypeRule } from "../../domain/title-types.js";
import type { ConfigFile } from "@flightdeck/rules";

const configSchema = v.object({
  errors: v.optional(v.never()),
  data: v.object({ repository: v.object({ yml: v.unknown(), yaml: v.unknown() }) }),
});
const blobSchema = v.object({ text: v.nullable(v.string()), isTruncated: v.boolean() });

const configFiles = (data: unknown): ConfigFile[] => {
  const parsed = v.parse(configSchema, data);
  const files: ConfigFile[] = [];

  for (const key of ["yml", "yaml"] as const) {
    const value = parsed.data.repository[key];
    if (value === null) continue;

    const blob = v.safeParse(blobSchema, value);
    files.push({ path: CONFIG_PATHS[key], text: blob.success && !blob.output.isTruncated ? blob.output.text : null });
  }

  return files;
};

export const readTitleTypeRulesFromBase = async (
  input: ResolvedTitleInputRequest
): Promise<TitleTypeRule[] | undefined> => {
  try {
    const data = await titleInputRequest(input, `${GITHUB_API_BASE_URL}/graphql`, {
      query: `query TitleConfig($owner: String!, $repo: String!, $yml: String!, $yaml: String!) {
        repository(owner: $owner, name: $repo) {
          yml: object(expression: $yml) { ... on Blob { text isTruncated } }
          yaml: object(expression: $yaml) { ... on Blob { text isTruncated } }
        }
      }`,
      variables: {
        owner: input.owner,
        repo: input.repo,
        yml: `${input.baseSha}:${CONFIG_PATHS.yml}`,
        yaml: `${input.baseSha}:${CONFIG_PATHS.yaml}`,
      },
    });

    return readTitleTypeRules(configFiles(data));
  } catch (error) {
    if (
      error instanceof TitleInputBudgetExceededError ||
      error instanceof SubrequestBudgetExceededError ||
      input.signal.aborted
    ) {
      throw error;
    }

    logTitleInputWarning(input, "config_unavailable", error instanceof Error ? error.message : "Unknown error");

    return undefined;
  }
};
