export type WebhookFeature = "auto-assign" | "title-validation";

export interface DeliveryRepository {
  has(deliveryId: string, feature: WebhookFeature, signal: AbortSignal): Promise<boolean>;
  markProcessed(deliveryId: string, feature: WebhookFeature, processedAt: Date, signal: AbortSignal): Promise<void>;
}
