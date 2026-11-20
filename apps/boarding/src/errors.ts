type BoardingErrorCode =
  | "API_ERROR"
  | "INVALID_RESPONSE"
  | "INCOMPLETE_PAGINATION"
  | "SUBREQUEST_LIMIT"
  | "INVALID_METADATA"
  | "INVALID_PROFILE"
  | "YAML_SIZE_LIMIT";

export class BoardingError extends Error {
  constructor(
    readonly code: BoardingErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BoardingError";
  }
}
