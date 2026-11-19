import { listWithinLimit } from "./list.js";
import { statusLabels } from "./status.js";
import { editorName } from "../domain/editors.js";

import type { Editor } from "../domain/editors.js";
import type { ManagementReason, ManagementRequest } from "../domain/management.js";
import type { MergeDecision } from "../domain/merge.js";
import type { EvaluationResult } from "../usecase/evaluate/interface.js";

const code = (value: string): string => {
  const text = value.replace(/[\r\n]/g, " ");
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
};

const cell = (value: string): string => value.replaceAll("|", "\\|");

// 一覧ごとの上限を合計しても GitHub のコメント上限を超えないようにする
const LIST_BUDGET = 8_000;
const list = <T>(items: T[], render: (item: T) => string, separator: string): string =>
  listWithinLimit(items, render, separator, LIST_BUDGET);

const modeLabels: Record<ManagementRequest["mode"], string> = {
  none: "通常の認可",
  intervention: "Intervention",
  offboarding: "Offboarding",
};

export const guidance: Record<EvaluationResult["reason"], string> = {
  AUTHORIZED: "必要な同意を確認しました。",
  NO_CONTENT_CHANGES: "著者のコンテンツに対する認可は不要です。設定の変更は通常のレビューを受けてください。",
  EVALUATING: "認可を確認しています。",
  INTERVENTION_QUORUM_MISSING:
    "PR 作成者以外の Org Owner 1 人以上と、別の Org Member 3 人以上に Approve を依頼してください。",
  OFFBOARDING_APPROVAL_MISSING: "PR 作成者以外の Org Owner に Approve を依頼してください。",
  OFFBOARDING_INVALID_CHANGES: "Offboarding は meta の editors の変更だけに分けてください。",
  OFFBOARDING_INVALID_TARGET: "削除対象は Org に所属しない個人 Editor に限ります。",
  EDITOR_APPROVAL_MISSING: "対象の Editor に現在のコミットをレビューし、Approve するよう依頼してください。",
  TEAM_MAINTAINER_REQUIRED: "追加または削除する Team の Maintainer に現在のコミットの Approve を依頼してください。",
  WEBSITE_MEMBER_CONSENT_MISSING:
    "対象の Org Member Editor に website の変更を確認し、Approve するよう依頼してください。",
  INVALID_EDITORS:
    "各 meta.yaml または meta.yml の editors が空でなく、存在するユーザーまたは公開 Team を重複なく指定しているか確認してください。",
  INVALID_PROFILE: "profile.yaml または profile.yml の YAML と website の値を確認し、修正して push してください。",
  INITIAL_AUTHOR_NOT_EDITOR: "新しい著者の editors に PR 作成者自身か、作成者が所属する Team を指定してください。",
  NON_CONTENT_CHANGE_FORBIDDEN:
    "対象外ファイルを PR から取り除いて push してください。設定や検証スクリプトの変更を提案する場合は Issue を作成してください。",
  AUTHOR_ROOT_CASE_CONFLICT:
    "既存の著者ディレクトリと大文字小文字だけが異なる名前を避け、既存ディレクトリを使うか別の名前に変更してください。",
  COMMIT_IDENTITY_MISMATCH:
    "各コミットの author と committer を PR 作成者の GitHub アカウントに合わせて作成し直し、push してください。",
  INCOMPLETE_DATA:
    "差分・コミット・所属情報などを完全に取得できませんでした。変更やコミットを減らして push するか、管理者に再実行を依頼してください。",
  API_ERROR: "GitHub の情報を確認できませんでした。しばらく待ってから管理者に再実行を依頼してください。",
  YAML_SIZE_LIMIT:
    "meta / profile の YAML を各ファイル 16 KiB 以下、変更対象の解析合計を 64 KiB 以下に整理して push してください。",
  SUBREQUEST_LIMIT: "変更や確認対象を減らして PR を分割し、再度 push してください。",
};

const invalidMerge: Record<Extract<MergeDecision, { request: "invalid" }>["reason"], string> = {
  INVALID_CHECKBOX: "チェック欄の形式が不正です",
  HISTORY_UNAVAILABLE: "編集履歴から本文と編集者を完全に確認できません",
  NOT_AUTHOR: "PR 作成者によるチェックを確認できません",
};

const invalidMergeGuidance: Record<Extract<MergeDecision, { request: "invalid" }>["reason"], string> = {
  INVALID_CHECKBOX:
    "本文のチェック欄をテンプレートの 1 行（`- [ ] すべてのチェックが成功したら自動マージする`）だけにしてからチェックしてください。",
  HISTORY_UNAVAILABLE:
    "PR 作成者がチェックを外して入れ直してください。編集履歴を確認できない状態が続く場合は管理者に相談してください。",
  NOT_AUTHOR: "PR 作成者がチェックを外して入れ直してください。",
};

const managementReasons: Record<ManagementReason, string> = {
  INVALID_CHECKBOX: "チェック欄の形式が不正です",
  HISTORY_UNAVAILABLE: "編集履歴を確認できません",
  NOT_AUTHOR: "PR 作成者によるチェックを確認できません",
  CONFLICT: "両方のモードは同時に申請できません",
  NOT_MEMBER: "PR 作成者が Org Member ではありません",
};

const managementWaitingReasons = new Set<EvaluationResult["reason"]>([
  "INTERVENTION_QUORUM_MISSING",
  "OFFBOARDING_APPROVAL_MISSING",
]);

const mergeWaiting: Record<NonNullable<Extract<MergeDecision, { request: "accepted" }>["waiting"]>, string> = {
  DRAFT: "Draft の解除",
  AUTHORIZATION: "認可",
  AUTHORS_ONLY: "著者コンテンツのみの変更",
  APP_APPROVAL: "App の Approve",
  CI_UNAVAILABLE: "CI の結果の取得",
  CI_PENDING: "CI の完了",
  CI_FAILED: "失敗した CI の修正",
};

const targetsText = (targets: Editor[] | undefined): string => {
  if (targets === undefined) return "確認できませんでした";
  if (targets.length === 0) return "なし";
  return list(targets, (editor) => code(editorName(editor)), ", ");
};

const managementLines = (management: EvaluationResult["management"]): string[] => {
  if (!management) return [];
  if (management.mode === "none") {
    return management.reason ? [`管理モードの申請: 無効（${managementReasons[management.reason]}）`] : [];
  }

  if (management.mode !== "offboarding") return [];

  return [`管理モードの対象: ${targetsText(management.targets)}`];
};

const alerts: Record<EvaluationResult["status"], string> = {
  allowed: "TIP",
  not_applicable: "NOTE",
  waiting: "IMPORTANT",
  rejected: "WARNING",
  error: "CAUTION",
};

const mergeText = (merge: EvaluationResult["merge"]): string => {
  if (!merge) return "確認できませんでした";
  if (merge.request === "none") return "依頼なし";
  if (merge.request === "invalid") return `無効（${invalidMerge[merge.reason]}）`;
  return merge.waiting ? `受理 / ${mergeWaiting[merge.waiting]}待ち` : "受理 / Merge を実行します";
};

const identityText = (result: EvaluationResult): string => {
  if (!result.facts) return "取得できませんでした";
  if (result.facts.invalidCommits.length) return "確認できないコミットがあります";
  if (result.reason === "COMMIT_IDENTITY_MISMATCH") return "コミットがありません";
  return "一致";
};

const details = (title: string, body: string[]): string[] => [
  "<details>",
  `<summary>${title}</summary>`,
  "",
  ...body,
  "",
  "</details>",
];

const missingLines = (result: EvaluationResult): string[] => {
  if (result.status !== "waiting" || managementWaitingReasons.has(result.reason)) return [];

  const root = result.details?.root;
  const lines = [`不足している同意: ${root ? code(root) : "対象著者を確認してください"}`];
  const missing = result.details?.missing;
  if (missing) {
    const names = list(
      missing.editors,
      (editor) => {
        const name = code(editorName(editor));
        return editor.type === "team" && result.reason === "TEAM_MAINTAINER_REQUIRED" ? `${name} の Maintainer` : name;
      },
      ", "
    );
    lines.push(`必要な同意: 次の${missing.kind === "all" ? "全員" : "うち 1 名"}: ${names}`);
  }
  return lines;
};

const pathsSection = (result: EvaluationResult): string[] => {
  const paths = result.facts?.otherPaths ?? [];
  if (!paths.length) return [];

  const body = [list(paths, (path) => `- ${code(path)}`, "\n")];
  if (result.reason === "NON_CONTENT_CHANGE_FORBIDDEN") {
    body.push(
      "",
      "対象ファイルを base の状態に戻すには `git restore --source origin/main -- <ファイル>` を実行し、変更をコミットして push してください。新規ファイルは削除してコミットしてください。"
    );
    return ["### 著者コンテンツ以外の変更", "", ...body];
  }
  return details("著者コンテンツ以外の変更", body);
};

const commitsSection = (result: EvaluationResult): string[] => {
  const bad = result.facts?.invalidCommits ?? [];
  if (!bad.length) return [];

  const body = [
    list(
      bad,
      (commit) => {
        const email =
          commit.authorId === null &&
          commit.authorEmail &&
          /^[^\s@]+@users\.noreply\.github\.com$/i.test(commit.authorEmail)
            ? `: ${code(commit.authorEmail)}`
            : "";
        return `- ${code(commit.sha)}${email}`;
      },
      "\n"
    ),
  ];
  if (bad.some((commit) => commit.authorId === null)) {
    body.push(
      "",
      "GitHub の Settings → Emails でコミットに使ったアドレスを追加するか、GitHub の noreply アドレスでコミットし直して push してください。"
    );
  }
  return details("本人確認に失敗したコミット", body);
};

export const authorizationComment = (result: EvaluationResult): string => {
  const rows: [string, string][] = [
    ["状態", `${statusLabels[result.status]}（${code(result.reason)}）`],
    ["モード", result.management ? modeLabels[result.management.mode] : "確認できませんでした"],
    ["対象著者", result.facts ? list(result.facts.authorRoots, code, ", ") || "なし" : "取得できませんでした"],
    ["コミットの本人確認", identityText(result)],
    ["自動マージ", mergeText(result.merge)],
  ];
  const management = managementLines(result.management);
  const sections: string[][] = [
    ["<!-- boarding:authorization -->", `> [!${alerts[result.status]}]`, `> ${guidance[result.reason]}`],
    [
      "## 認可結果",
      "",
      "| 項目 | 結果 |",
      "| --- | --- |",
      ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`),
    ],
    result.merge?.request === "invalid" ? [invalidMergeGuidance[result.merge.reason]] : [],
    management,
    missingLines(result),
    pathsSection(result),
    commitsSection(result),
  ];
  return sections
    .filter((section) => section.length)
    .map((section) => section.join("\n"))
    .join("\n\n");
};
