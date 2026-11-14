import { runSetGitHubPrivateKeyCli } from "@flightdeck/private-key-env";

runSetGitHubPrivateKeyCli("GITHUB_APP_PRIVATE_KEY", import.meta.url);
