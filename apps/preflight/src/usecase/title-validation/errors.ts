type TitleValidationFailureStage =
  "comment_sync_failed" | "identity_validation_failed" | "state_changed" | "state_lookup_failed" | "status_failed";

export class TitleValidationExecutionError extends Error {
  constructor(
    readonly stage: TitleValidationFailureStage,
    override readonly cause: unknown
  ) {
    super(stage, { cause });
    this.name = "TitleValidationExecutionError";
  }
}
