import type { WorkflowRun } from "../../domain/workflow.js";

export interface WorkflowDependencies {
  list: (sha: string) => Promise<WorkflowRun[]>;
  approve: (runs: WorkflowRun[]) => Promise<void>;
}
