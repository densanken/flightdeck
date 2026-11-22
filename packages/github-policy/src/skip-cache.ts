import type { SkipCache } from "@flightdeck/rules";

// 評価しても対象外のままと分かっている PR の branch を、Cache API に覚える
// Cache API は data center ごとで、保存の保証もないため、覚えていなければ評価に進む
// App をまたいで共有できるよう、key は App に依存しない固定の URL にする
const KEY_ORIGIN = "https://skip-cache.flightdeck.internal";

const keyOf = (repositoryId: number, branch: string) =>
  `${KEY_ORIGIN}/${String(repositoryId)}/${encodeURIComponent(branch)}`;

export const createSkipCache = (cache: Pick<Cache, "match" | "put">): SkipCache => ({
  has: async (repositoryId, branches) => {
    if (branches.length === 0) return false;

    try {
      const hits = await Promise.all(branches.map((branch) => cache.match(keyOf(repositoryId, branch))));

      return hits.every((hit) => hit !== undefined);
    } catch {
      return false;
    }
  },

  remember: async (repositoryId, branch, until, now) => {
    const seconds = Math.floor((until - now) / 1000);
    if (seconds <= 0) return;

    try {
      await cache.put(
        keyOf(repositoryId, branch),
        new Response("", { headers: { "Cache-Control": `max-age=${String(seconds)}` } })
      );
    } catch {
      // 覚えられなくても、次の webhook で評価に進むだけ
    }
  },
});
