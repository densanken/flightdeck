import { describe, expect, it } from "vitest";

import { failureErrorCode, underlyingError } from "./feature-result.js";
import { ConfigurationError, GitHubError } from "../../errors.js";
import { TitleValidationExecutionError } from "../../usecase/title-validation/errors.js";

import type { FeatureResult } from "../../usecase/pull-request-policy/interface.js";

type FailedFeature = Extract<FeatureResult, { outcome: "failed" }>;

const failed = (error: unknown, feature: FailedFeature["feature"] = "auto-assign"): FailedFeature => ({
  feature,
  outcome: "failed",
  error,
});

describe("failureErrorCode", () => {
  it("GitHub の error が先にあっても設定不備を優先し INTERNAL_ERROR を返す", () => {
    expect(
      failureErrorCode([
        failed(new GitHubError("GITHUB_API_FAILED", "boom", 503), "title-validation"),
        failed(new ConfigurationError("GITHUB_APP_BOT_USER_ID", "invalid")),
      ])
    ).toBe("INTERNAL_ERROR");
  });

  it("AppError ではない error を GitHub の error より優先し、内部障害を GitHub の失敗で隠さない", () => {
    expect(
      failureErrorCode([
        failed(new GitHubError("GITHUB_API_FAILED", "boom", 503), "title-validation"),
        failed(new Error("unexpected")),
      ])
    ).toBe("INTERNAL_ERROR");
  });

  it("GitHub の error だけのときは GITHUB_API_FAILED を返す", () => {
    expect(failureErrorCode([failed(new GitHubError("GITHUB_API_FAILED", "boom", 503), "title-validation")])).toBe(
      "GITHUB_API_FAILED"
    );
  });

  it("TitleValidationExecutionError は内側の GitHub の error まで展開してから code を選ぶ", () => {
    const wrapped = new TitleValidationExecutionError(
      "status_failed",
      new GitHubError("GITHUB_API_FAILED", "boom", 502)
    );

    expect(failureErrorCode([failed(wrapped, "title-validation")])).toBe("GITHUB_API_FAILED");
  });
});

describe("underlyingError", () => {
  it("TitleValidationExecutionError は cause を返し、それ以外は error 自身を返す", () => {
    const githubError = new GitHubError("GITHUB_API_FAILED", "boom");

    expect(underlyingError(new TitleValidationExecutionError("state_changed", githubError))).toBe(githubError);
    expect(underlyingError(githubError)).toBe(githubError);
  });
});
