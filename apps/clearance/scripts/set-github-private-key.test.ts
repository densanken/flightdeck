import { runSetGitHubPrivateKeyCli } from "@flightdeck/private-key-env";
import { describe, expect, it, vi } from "vitest";

import "./set-github-private-key.js";

vi.mock("@flightdeck/private-key-env", () => ({ runSetGitHubPrivateKeyCli: vi.fn() }));

describe("set-github-private-key", () => {
  it("共有 CLI に環境変数名とスクリプト URL を渡す", () => {
    expect(runSetGitHubPrivateKeyCli).toHaveBeenCalledWith(
      "GITHUB_PRIVATE_KEY",
      expect.stringMatching(/set-github-private-key\.ts$/)
    );
  });
});
