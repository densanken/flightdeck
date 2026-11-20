import { commitSha } from "@flightdeck/validation";
import * as v from "valibot";

import { changedFilesSchema } from "./pull-request-schema.js";
import { GITHUB_API_BASE_URL } from "./request.js";
import { logTitleInputWarning, TitleInputBudgetExceededError, titleInputRequest } from "./title-input-request.js";
import { PullRequestStateChangedError } from "../../errors.js";

import type { ResolvedTitleInputRequest, TitleInputRequest } from "./title-input-request.js";
import type { TitleTypeInputs } from "../../domain/title-types.js";

const MAX_CHANGED_FILES = 3000;
const FILES_PER_PAGE = 100;

const prSchema = v.object({
  head: v.object({ sha: commitSha }),
  base: v.object({ sha: commitSha }),
  changed_files: changedFilesSchema,
});
const fileSchema = v.array(v.object({ filename: v.string(), previous_filename: v.optional(v.string()) }));

export const resolvePullRequestFiles = async (input: TitleInputRequest): Promise<ResolvedTitleInputRequest> => {
  const root = `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${String(input.pullRequestNumber)}`;
  let { baseSha, changedFiles } = input;

  if (baseSha === undefined || changedFiles === undefined) {
    const pr = v.parse(prSchema, await titleInputRequest(input, root));
    if (pr.head.sha !== input.headSha || (baseSha !== undefined && pr.base.sha !== baseSha)) {
      throw new PullRequestStateChangedError();
    }

    baseSha = pr.base.sha;
    changedFiles = pr.changed_files;
  }

  return { ...input, root, baseSha, changedFiles };
};

export const loadPullRequestFiles = async (
  input: ResolvedTitleInputRequest
): Promise<Pick<TitleTypeInputs, "files" | "filesComplete">> => {
  const { root, changedFiles } = input;
  if (changedFiles > MAX_CHANGED_FILES) {
    logTitleInputWarning(input, "changed_files_limit_exceeded");
    return { files: [], filesComplete: false };
  }

  if (Math.ceil(changedFiles / FILES_PER_PAGE) > input.remainingInputRequests()) {
    logTitleInputWarning(input, "changed_files_budget_exceeded");
    throw new TitleInputBudgetExceededError();
  }

  const files: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;

  for (let page = 1; fetched < changedFiles; page += 1) {
    const value = await titleInputRequest(
      input,
      `${root}/files?per_page=${String(FILES_PER_PAGE)}&page=${String(page)}`
    );
    const parsed = v.safeParse(fileSchema, value);

    if (!parsed.success || parsed.output.length === 0 || fetched + parsed.output.length > changedFiles) {
      throw new Error("Invalid pull request files response");
    }

    fetched += parsed.output.length;

    for (const file of parsed.output) {
      if (seen.has(file.filename)) throw new Error("Duplicate pull request file");
      seen.add(file.filename);
      files.push(file.filename);
      if (file.previous_filename !== undefined) files.push(file.previous_filename);
    }
  }

  return { files, filesComplete: true };
};
