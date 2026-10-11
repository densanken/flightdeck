/**
 * autocomplete は 1 文字入力するたびに interaction を発火するため、cache が cold な間は
 * 同じ読み込みが入力の数だけ並走する
 * 応答を打ち切っても読み込み自体は warming として走り続けるため、
 * 1 文字ごとに installation token 取得や KV の全件 list が増幅する
 * isolate 内で同じ key の読み込みを 1 本にまとめ、後続はその promise を共有する
 */

// key ごとの実行中の promise
// settle した時点で取り除き、次の request では読み直す
const inflight = new Map<string, Promise<unknown>>();

export const INSTALLATION_REPOSITORIES_KEY = "installation_repositories";
export const REPOSITORY_INDEX_KEY = "repository_index";
export const pullRequestsKey = (repoId: string): string => `pull_requests:${repoId}`;

/** 同じ key の読み込みが実行中ならその promise を返し、無ければ `fn` を起動して登録する */
export const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const started = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
};

/** isolate をまたがない test で前の test の in-flight を持ち越さないために使う */
export const resetSingleFlight = (): void => {
  inflight.clear();
};
