import { hasPendingCi } from "../../domain/merge.js";

import type { FanoutDependencies } from "./dependencies.js";
import type { FanoutUseCase } from "./interface.js";

export class FanoutUseCaseImpl implements FanoutUseCase {
  constructor(private readonly dependencies: FanoutDependencies) {}

  async execute(input: Parameters<FanoutUseCase["execute"]>[0]): Promise<void> {
    if (input.event === "permissions-changed") await this.dependencies.verifyInstallation();

    const numbers = await this.pullRequests(input);
    if (numbers.length === 0) return;

    const messages = [...new Set(numbers)].map((number) => ({
      event: "evaluate" as const,
      deliveryId: input.deliveryId,
      installationId: input.installationId,
      number,
    }));

    await this.dependencies.enqueue(messages);
  }

  private async pullRequests(input: Parameters<FanoutUseCase["execute"]>[0]): Promise<number[]> {
    if (input.event !== "ci-completed" && input.event !== "ci-requested") {
      return this.dependencies.listOpenPullRequests();
    }

    const { numbers, ci } = await this.dependencies.associatedPullRequests(input.sha, input.repositoryId);
    return input.event === "ci-completed" && hasPendingCi(ci, this.dependencies.appId) ? [] : numbers;
  }
}
