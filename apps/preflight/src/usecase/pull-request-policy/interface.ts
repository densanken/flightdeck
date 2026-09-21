import type { WebhookFeature } from "../../repository/delivery/interface.js";
import type { AssignmentResult } from "../assignment/interface.js";
import type { TitleValidationOutcome } from "../title-validation/interface.js";

export interface PullRequestPolicyCommand {
  deliveryId: string;
  action: string;
  titleChanged: boolean;
  installationId: number;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  fallbackHeadSha: string;
  previousHeadSha?: string;
  author: string;
  authorType: string;
  assignees: string[];
}

export type FeatureProcessedResult =
  | {
      feature: "auto-assign";
      outcome: "processed";
      result: AssignmentResult;
    }
  | ({ feature: "title-validation"; outcome: "processed" } & TitleValidationOutcome);

export type FeatureResult =
  | FeatureProcessedResult
  | { feature: WebhookFeature; outcome: "duplicate" }
  | { feature: WebhookFeature; outcome: "failed"; error: unknown };

export interface PolicyWarning {
  feature: WebhookFeature;
  code: "delivery_lookup_failed" | "delivery_record_failed";
}

export interface PullRequestPolicyOutcome {
  features: FeatureResult[];
  warnings: PolicyWarning[];
  result: string;
}

export interface PullRequestPolicyUseCase {
  execute(
    command: PullRequestPolicyCommand,
    signal: AbortSignal,
    hardDeadlineSignal?: AbortSignal
  ): Promise<PullRequestPolicyOutcome>;
}
