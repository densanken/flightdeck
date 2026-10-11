export const cacheKeys = {
  prList: (cacheBaseUrl: string, repoId: string) => `${cacheBaseUrl}/_cache/pr-list/${repoId}`,

  repoIndex: (cacheBaseUrl: string) => `${cacheBaseUrl}/_cache/repo-index`,

  mergeCooldown: (cacheBaseUrl: string, repoId: string, prNumber: number) =>
    `${cacheBaseUrl}/_cache/merge-cooldown/${repoId}/${String(prNumber)}`,

  syncCooldown: (cacheBaseUrl: string, repoId: string) => `${cacheBaseUrl}/_cache/sync-cooldown/${repoId}`,

  // App / org を変更した直後に古い installation ID を読み続けないよう、両方を key に含める
  installationId: (cacheBaseUrl: string, appId: string, org: string) =>
    `${cacheBaseUrl}/_cache/installation-id/${encodeURIComponent(appId)}/${encodeURIComponent(org)}`,

  // installation token は secret のため Cache API へ渡してはならず、この key は
  // isolate 内の memoryCache 専用とする（`infrastructure/github/app-auth.ts`）
  installationToken: (cacheBaseUrl: string, installationId: number) =>
    `${cacheBaseUrl}/_cache/installation-token/${String(installationId)}`,

  installationRepositories: (cacheBaseUrl: string) => `${cacheBaseUrl}/_cache/installation-repositories`,
};
