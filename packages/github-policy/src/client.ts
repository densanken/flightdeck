import { CONFIG_PATHS, splitRepository, STALE_MS } from "@flightdeck/rules";

import { parseResponse } from "./error.js";
import { ApiError, GitHubDataError } from "./errors.js";
import { normalizeConfigs, normalizePr } from "./normalize.js";
import { ASSOCIATED_QUERY, COMPARE_QUERY, CONFIG_QUERY, PR_QUERY, TREE_QUERY } from "./query.js";
import { GitHubRequest } from "./request.js";
import {
  ancestryResponse,
  associatedResponse,
  compareResponse,
  configResponse,
  prResponse,
  requiredChecks,
  rulesResponse,
  treesResponse,
} from "./schema.js";

import type { RequiredStatusCheck } from "@flightdeck/rules";

export class GitHubPolicyGatewayImpl {
  private readonly rulesCache = new Map<string, Promise<RequiredStatusCheck[]>>();

  constructor(
    readonly request: GitHubRequest,
    readonly repository: string
  ) {}

  protected repoPath(repository: string): string {
    return repository.split("/").map(encodeURIComponent).join("/");
  }

  authenticate() {
    return this.request.authenticate();
  }

  subrequests() {
    return this.request.count;
  }

  async pullRequest(number: number, now: number) {
    const data = parseResponse(
      prResponse,
      await this.request.graphql(PR_QUERY, {
        ...splitRepository(this.repository),
        number,
        cutoff: new Date(now - STALE_MS).toISOString(),
      })
    );

    if (!data.repository.pullRequest) throw new Error("pull request missing");

    return {
      repositoryId: data.repository.databaseId,
      pr: normalizePr(data.repository.pullRequest),
      queryCost: data.rateLimit?.cost,
    };
  }

  async configs(baseOid: string) {
    const configs = parseResponse(
      configResponse,
      await this.request.graphql(CONFIG_QUERY, {
        ...splitRepository(this.repository),
        yml: `${baseOid}:${CONFIG_PATHS.yml}`,
        yaml: `${baseOid}:${CONFIG_PATHS.yaml}`,
      })
    );

    return normalizeConfigs(configs.repository);
  }

  async trees(baseOid: string, headOid: string, path: string) {
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const expression = (oid: string) => (parent ? `${oid}:${parent}` : `${oid}^{tree}`);
    const data = parseResponse(
      treesResponse,
      await this.request.graphql(TREE_QUERY, {
        ...splitRepository(this.repository),
        base: expression(baseOid),
        head: expression(headOid),
      })
    );

    // tree を取得できないことと、取得した tree に path がないことを区別する
    if (!data.repository.base?.entries || !data.repository.head?.entries) {
      throw new GitHubDataError("tree_unavailable", "parent tree unavailable");
    }

    return {
      base: data.repository.base.entries.find((item) => item.name === name) ?? null,
      head: data.repository.head.entries.find((item) => item.name === name) ?? null,
    };
  }

  // PR の query の後に path の tree から新しい gitlink SHA が分かるため、Ref.compare は別 query で取得する
  async compare(source: string, newer: string, older: string) {
    const data = parseResponse(
      compareResponse,
      await this.request.graphql(COMPARE_QUERY, { ...splitRepository(source), new: newer })
    );
    const status = data.repository?.defaultBranchRef?.compare?.status;
    if (!status) throw new Error("source comparison missing");

    // 新しい SHA から古い SHA の向きで比べると、merge base が古い SHA になり、応答が小さく収まる
    const result = await this.request.request(
      `/repos/${this.repoPath(source)}/compare/${encodeURIComponent(newer)}...${encodeURIComponent(older)}`
    );
    return { source: status, ancestry: parseResponse(ancestryResponse, result.data).status };
  }

  rules(branch: string): Promise<RequiredStatusCheck[]> {
    const cached = this.rulesCache.get(branch);
    if (cached) return cached;

    const result = this.readRules(branch);
    this.rulesCache.set(branch, result);

    return result;
  }

  private async readRules(branch: string): Promise<RequiredStatusCheck[]> {
    const result = await this.request
      .request(
        `/repos/${this.repoPath(this.repository)}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=1`
      )
      .catch((error: unknown) => {
        // 対応 plan でない場合は rules が存在しないものとして扱う
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          !error.rateLimited &&
          error.detail.includes("upgrade to github pro") &&
          error.detail.includes("make this repository public") &&
          error.detail.includes("enable this feature")
        ) {
          return undefined;
        }

        throw error;
      });

    if (result === undefined) return [];
    if (result.response.headers.get("link")?.includes('rel="next"')) {
      throw new GitHubDataError("connection_truncated", "rules truncated");
    }

    const rules = parseResponse(rulesResponse, result.data);

    return rules.flatMap((rule) => {
      if (rule.type !== "required_status_checks") return [];

      return parseResponse(requiredChecks, rule.parameters).required_status_checks.map((item) => ({
        context: item.context,
        integrationId: item.integration_id ?? null,
      }));
    });
  }

  async associated(sha: string, repositoryId: number) {
    const data = parseResponse(
      associatedResponse,
      await this.request.graphql(ASSOCIATED_QUERY, { ...splitRepository(this.repository), oid: sha })
    );
    const commit = data.repository.object;
    const connections = commit
      ? [commit.associatedPullRequests, ...commit.parents.nodes.map((parent) => parent.associatedPullRequests)]
      : [null];
    if (connections.some((item) => !item || item.totalCount !== item.nodes.length)) {
      throw new GitHubDataError("connection_truncated", "associated pull requests truncated");
    }

    // 別 repository の PR や、head と potentialMergeCommit のどちらにも一致しない PR は評価しない
    return connections
      .flatMap((item) => item?.nodes ?? [])
      .filter(
        (pr) =>
          pr.state === "OPEN" &&
          pr.repository.databaseId === repositoryId &&
          (pr.headRefOid === sha || pr.potentialMergeCommit?.oid === sha)
      )
      .map((pr) => pr.number);
  }
}
