export interface FanoutUseCase {
  execute(input: { deliveryId: string; installationId: number; event: "push" | "permissions-changed" }): Promise<void>;
}
