export interface GitHubWebhookQueueMessage {
  version: 1;
  event: "pull_request";
  deliveryId: string;
  body: string;
}
