import { AppError, ConfigurationError } from "../../errors.js";
import { TitleValidationExecutionError } from "../../usecase/title-validation/errors.js";

import type { ErrorCode } from "../../errors.js";
import type { FeatureResult } from "../../usecase/pull-request-policy/interface.js";

export const underlyingError = (error: unknown): unknown =>
  error instanceof TitleValidationExecutionError ? error.cause : error;

/**
 * 複数機能が失敗したときに代表となる error code を選ぶ
 * 設定不備を最優先し、次に AppError ではない内部障害を選ぶ
 * GitHub の失敗で内部障害を隠さないため
 */
export const failureErrorCode = (failures: Extract<FeatureResult, { outcome: "failed" }>[]): ErrorCode => {
  const errors = failures.map((failure) => underlyingError(failure.error));
  const error =
    errors.find((candidate) => candidate instanceof ConfigurationError) ??
    errors.find((candidate) => !(candidate instanceof AppError)) ??
    errors[0];
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
};
