import { GitHubPolicyGatewayImpl, normalizeReview, parseResponse } from "@flightdeck/github-policy";

import { SEARCH_QUERY } from "./query.js";
import { reviewResponse, reviewStateResponse, searchResponse } from "./schema.js";

import type { ApprovalGateway } from "../../usecase/approval/dependencies.js";

export class GitHubGatewayImpl extends GitHubPolicyGatewayImpl implements ApprovalGateway {
  async approve(number: number, sha: string) {
    const response = await this.request.request(
      `/repos/${this.repoPath(this.repository)}/pulls/${String(number)}/reviews`,
      "POST",
      { event: "APPROVE", commit_id: sha }
    );

    return { status: response.response.status, reviewId: parseResponse(reviewResponse, response.data).id };
  }

  async dismiss(number: number, reviewId: number, reason: string) {
    const response = await this.request.request(
      `/repos/${this.repoPath(this.repository)}/pulls/${String(number)}/reviews/${String(reviewId)}/dismissals`,
      "PUT",
      { message: `conditions no longer met (${reason})` }
    );

    return { status: response.response.status };
  }

  async reviewState(number: number, reviewId: number) {
    const response = await this.request.request(
      `/repos/${this.repoPath(this.repository)}/pulls/${String(number)}/reviews/${String(reviewId)}`
    );

    return parseResponse(reviewStateResponse, response.data).state;
  }

  async search(date: string) {
    const query = `repo:${this.repository} is:pr is:open draft:false created:<${date} -label:"autopilot:skip"`;
    const data = parseResponse(searchResponse, await this.request.graphql(SEARCH_QUERY, { query }));

    return data.search.nodes.map((pr) => ({
      number: pr.number,
      authorId: pr.author?.databaseId ?? null,
      headSha: pr.headRefOid,
      reviewsComplete: pr.latestReviews.totalCount === pr.latestReviews.nodes.length,
      reviews: pr.latestReviews.nodes.map(normalizeReview),
    }));
  }
}
