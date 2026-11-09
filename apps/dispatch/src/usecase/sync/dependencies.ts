import type { ConfigFile } from "../../domain/config.js";
import type { Submodule } from "../../domain/gitmodules.js";
import type { IncludedCommits } from "../../domain/pull-request-body.js";
import type { DispatchMessage } from "../../message/webhook.js";
import type { Logger } from "../../util/logger.js";

export interface RepositoryInfo {
  // GitHub が返す正規名
  // branch 名と title はこの名前から作る
  fullName: string;
  defaultBranch: string;
}

export interface OpenPullRequest {
  number: number;
  title: string;
  baseBranch: string;
  body: string;
}

// 管理 branch を head とする、Close 済みか merge 済みの PR
export interface ClosedPullRequest {
  number: number;
  title: string;
  merged: boolean;
  // Close したとき（merge したとき）の head
  headSha: string;
}

export type RefUpdateResult = "updated" | "conflict";

export interface BranchHead {
  sha: string;
  parentShas: string[];
  message: string;
  // path の gitlink
  // gitlink でなければ undefined
  gitlinkSha: string | undefined;
  // 変更されたファイルの数
  // GitHub が数えられなければ null
  changedFiles: number | null;
}

// push などの event を受けた repository の状態
// source としての情報（default branch と設定）と、parent としての情報（管理 branch）を 1 回で読む
// 設定は YAML の本文のまま持ち、読み取りは use case が行う
export interface RepositoryState {
  repository: RepositoryInfo;
  // default branch の HEAD
  // default branch がなければ undefined
  sha: string | undefined;
  // HEAD にある設定ファイル（flightdeck.yml と flightdeck.yaml）
  // ないものは含めない
  configs: ConfigFile[];
  // previous にある設定ファイル
  // previous を指定しなかった、または見つからなければ undefined
  previous: { configs: ConfigFile[] } | undefined;
  // withManaged を指定したときの、Open PR を持つ管理 branch（branch ごとに PR の base）
  // 数が多すぎて信用できなければ "overflow"
  managed: { head: string; baseBranches: string[] }[] | "overflow";
}

// parent repository の 1 回分の状態
export interface ParentState {
  repository: RepositoryInfo;
  // 対象の base branch
  // 存在しなければ undefined
  base:
    | {
        branch: string;
        sha: string;
        treeSha: string;
        // path が gitlink でなければ undefined
        gitlinkSha: string | undefined;
        // GitHub が .gitmodules を解釈した submodule の一覧
        submodules: Submodule[];
      }
    | undefined;
  // 管理 branch の HEAD commit
  // なければ undefined
  branch: BranchHead | undefined;
  // 管理 branch を head とする Open PR
  pullRequests: OpenPullRequest[];
  // 管理 branch を head とする PR のうち、最後に Close か merge されたもの
  // Open の PR がある、または Close 済みの PR がなければ undefined
  lastClosedPullRequest: ClosedPullRequest | undefined;
}

// Use case が実際に使う操作だけを持つ
// repository は owner/repo 形式で渡し、認証は実装側が解決する
// 一時的な失敗は DispatchError("retryable")、権限不足は DispatchError("permission") で表す
export interface DispatchGateway {
  // branch が存在しなければ undefined
  getBranchHead(repository: string, branch: string): Promise<string | undefined>;
  // previous は設定の差分を取る前の commit（push の before）か branch（変更前の default branch）
  readRepositoryState(
    repository: string,
    options?: { previous?: { sha: string } | { branch: string }; withManaged?: boolean }
  ): Promise<RepositoryState>;
  // baseBranch を省略すると、parent の default branch を base とする
  readParentState(
    repository: string,
    input: { baseBranch: string | undefined; head: string; path: string }
  ): Promise<ParentState>;
  // head が管理 branch の Open PR（同じ repository の branch を head とする PR だけ）と、repository の正規名
  readManagedPullRequests(
    repository: string,
    head: string
  ): Promise<{ fullName: string; pullRequests: OpenPullRequest[] }>;
  // 書き込みの直前の確認
  // source の default branch の名前と HEAD、parent の base の HEAD が、どちらも変わっていなければ true
  checkUnchanged(input: {
    source: { repository: string; defaultBranch: string; sha: string };
    parent: { repository: string; branch: string; sha: string };
  }): Promise<boolean>;
  createPullRequest(
    repository: string,
    input: { head: string; base: string; title: string; body: string }
  ): Promise<void>;
  updatePullRequest(
    repository: string,
    number: number,
    patch: { baseBranch?: string; title?: string; body?: string; closed?: boolean }
  ): Promise<void>;
  // Close 済みの PR を Open に戻し、title を書き換える
  // GitHub が拒否したら（Close 中に head が force push された場合など）false
  reopenPullRequest(repository: string, number: number, title: string): Promise<boolean>;
  // head にあって base にない commit（多ければ新しい側だけ）
  // 比べられなければ（base が repository にない）undefined
  compareCommits(repository: string, base: string, head: string): Promise<IncludedCommits | undefined>;
  createGitlinkTree(
    repository: string,
    input: { baseTreeSha: string; path: string; gitlinkSha: string }
  ): Promise<string>;
  createCommit(repository: string, input: { treeSha: string; parentSha: string; message: string }): Promise<string>;
  // before が undefined なら branch を新規作成する
  // before と実際の HEAD が異なれば conflict
  updateRef(
    repository: string,
    branch: string,
    input: { before: string | undefined; after: string }
  ): Promise<RefUpdateResult>;
}

// use case が Queue へ積む子 message
// target の同期か、設定から削除された target の PR の Close
// source は子 message を積む元の source、target は設定に書かれた parent の名前（parent の push では parent の正規名）
// Queue の message の型から導き、deliveryId と installation は積む側（composition）が付ける
export type ChildMessage = Omit<
  Extract<DispatchMessage, { event: "sync-target" | "close-target" }>,
  "deliveryId" | "installation"
>;

export interface SyncDependencies {
  gateway: DispatchGateway;
  // 子 message を Queue へ積む
  // 1 回の呼び出しで複数をまとめて積める
  enqueue: (messages: ChildMessage[]) => Promise<void>;
  logger: Logger;
}
