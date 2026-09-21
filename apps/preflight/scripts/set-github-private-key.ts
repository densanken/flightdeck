import { runSetGitHubPrivateKeyCli } from "@flightdeck/private-key-env";

// preflight は .env の GitHub App 秘密鍵を GITHUB_PRIVATE_KEY として保持する
export const PRIVATE_KEY_ENV_KEY = "GITHUB_PRIVATE_KEY";

runSetGitHubPrivateKeyCli(PRIVATE_KEY_ENV_KEY, import.meta.url);
