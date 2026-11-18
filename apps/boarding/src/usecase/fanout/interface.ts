export interface FanoutUseCase {
  execute(
    input:
      | { deliveryId: string; installationId: number; event: "push" | "permissions-changed" }
      | {
          deliveryId: string;
          installationId: number;
          event: "ci-completed";
          sha: string;
          repositoryId: number;
        }
  ): Promise<void>;
}
