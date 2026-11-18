import type { FanoutDependencies } from "./dependencies.js";
import type { FanoutUseCase } from "./interface.js";

export class FanoutUseCaseImpl implements FanoutUseCase {
  constructor(private readonly dependencies: FanoutDependencies) {}

  async execute(input: {
    deliveryId: string;
    installationId: number;
    event: "push" | "permissions-changed";
  }): Promise<void> {
    if (input.event === "permissions-changed") await this.dependencies.verifyInstallation();

    const numbers = await this.dependencies.listOpenPullRequests();
    const messages = numbers.map((number) => ({
      event: "evaluate" as const,
      deliveryId: input.deliveryId,
      installationId: input.installationId,
      number,
    }));

    await this.dependencies.enqueue(messages);
  }
}
