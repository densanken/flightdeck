export interface NotificationUseCase {
  execute(input: { number: number }): Promise<void>;
}
