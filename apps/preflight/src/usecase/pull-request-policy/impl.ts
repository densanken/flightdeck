import { triggersAutoAssign, triggersTitleValidation } from "../../domain/webhook-actions.js";

import type { PullRequestPolicyDependencies, PullRequestPolicyGateway } from "./dependencies.js";
import type {
  FeatureProcessedResult,
  FeatureResult,
  PolicyWarning,
  PullRequestPolicyCommand,
  PullRequestPolicyOutcome,
  PullRequestPolicyUseCase,
} from "./interface.js";
import type { WebhookFeature } from "../../repository/delivery/interface.js";

const targetFeatures = (command: PullRequestPolicyCommand): WebhookFeature[] => {
  const features: WebhookFeature[] = [];
  if (triggersAutoAssign(command.action)) features.push("auto-assign");
  if (triggersTitleValidation(command.action, command.titleChanged)) features.push("title-validation");
  return features;
};

const summarize = (features: FeatureResult[]): string => {
  const processed = features.filter((feature): feature is FeatureProcessedResult => feature.outcome === "processed");
  const assignment = processed.find((feature) => feature.feature === "auto-assign");
  if (assignment?.feature === "auto-assign") return assignment.result;
  const titleValidation = processed.find((feature) => feature.feature === "title-validation");
  if (titleValidation?.feature === "title-validation") return `title_${titleValidation.result}`;
  return features.length > 0 && features.every((feature) => feature.outcome === "duplicate")
    ? "duplicate"
    : "ignored_action";
};

export class PullRequestPolicyUseCaseImpl implements PullRequestPolicyUseCase {
  constructor(private readonly dependencies: PullRequestPolicyDependencies) {}

  async execute(
    command: PullRequestPolicyCommand,
    signal: AbortSignal,
    hardDeadlineSignal: AbortSignal = signal
  ): Promise<PullRequestPolicyOutcome> {
    const warnings: PolicyWarning[] = [];
    const results: FeatureResult[] = [];
    let gateway: PullRequestPolicyGateway | undefined;
    const getGateway = (): PullRequestPolicyGateway => {
      gateway ??= this.dependencies.createGateway(command.installationId);
      return gateway;
    };

    for (const feature of targetFeatures(command)) {
      results.push(
        await this.executeFeature(command, feature, warnings, signal, async () => {
          if (feature === "auto-assign") {
            const outcome = await this.dependencies.createAssignmentUseCase(getGateway()).execute(
              {
                action: command.action,
                owner: command.owner,
                repo: command.repo,
                pullRequestNumber: command.pullRequestNumber,
                author: command.author,
                authorType: command.authorType,
                assignees: command.assignees,
              },
              signal
            );
            return { feature, outcome: "processed", result: outcome.result };
          }

          const outcome = await this.dependencies.createTitleValidationUseCase(getGateway()).execute(
            {
              owner: command.owner,
              repo: command.repo,
              pullRequestNumber: command.pullRequestNumber,
              fallbackHeadSha: command.fallbackHeadSha,
              previousHeadSha: command.previousHeadSha,
            },
            signal,
            hardDeadlineSignal
          );
          return { feature, outcome: "processed", ...outcome };
        })
      );
    }

    return { features: results, warnings, result: summarize(results) };
  }

  private async executeFeature(
    command: PullRequestPolicyCommand,
    feature: WebhookFeature,
    warnings: PolicyWarning[],
    signal: AbortSignal,
    operation: () => Promise<FeatureProcessedResult>
  ): Promise<FeatureResult> {
    try {
      if (await this.dependencies.deliveryRepository.has(command.deliveryId, feature, signal)) {
        return { feature, outcome: "duplicate" };
      }
    } catch {
      warnings.push({ feature, code: "delivery_lookup_failed" });
    }

    let result: FeatureProcessedResult;
    try {
      result = await operation();
    } catch (error) {
      return { feature, outcome: "failed", error };
    }

    try {
      await this.dependencies.deliveryRepository.markProcessed(
        command.deliveryId,
        feature,
        this.dependencies.now?.() ?? new Date(),
        signal
      );
    } catch {
      warnings.push({ feature, code: "delivery_record_failed" });
    }
    return result;
  }
}
