export interface NotificationUseCase {
  execute(input: { number: number; merged: boolean }): Promise<void>;
}
