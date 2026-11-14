export interface MergeContext {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  repository: string;
}

export type MergeInput = MergeContext &
  ({ kind: "pull_request"; number: number } | { kind: "commit"; sha: string; numbers?: number[] });

export interface MergeUseCase {
  execute(input: MergeInput): Promise<void>;
}
