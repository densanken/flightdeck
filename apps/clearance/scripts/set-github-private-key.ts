import { runSetGitHubPrivateKeyCli } from "@flightdeck/private-key-env";

runSetGitHubPrivateKeyCli("GITHUB_PRIVATE_KEY", import.meta.url);
