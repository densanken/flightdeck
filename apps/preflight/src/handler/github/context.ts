export interface RequestLogContext {
  deliveryId?: string;
  githubEvent?: string;
  action?: string;
  repository?: string;
  pullRequestNumber?: number;
  author?: string;
  installationId?: number;
  titleLength?: number;
}
