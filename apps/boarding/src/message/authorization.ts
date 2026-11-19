import { listWithinLimit } from "./list.js";
import { reasonLabels, statusLabels } from "./status.js";
import { editorName } from "../domain/editors.js";
import { consentLabels, mergeLabel } from "../domain/merge-request.js";

import type { Editor } from "../domain/editors.js";
import type { ManagementMode, ManagementReason } from "../domain/management.js";
import type { ConsentStatus } from "../domain/merge-request.js";
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

// 一覧は表で出し、長い場合は LIST_BUDGET で行を打ち切る
const table = <T>(headers: string[], items: T[], render: (item: T) => string[]): string[] => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  list(items, (item) => `| ${render(item).map(cell).join(" | ")} |`, "\n"),
];
const list = <T>(items: T[], render: (item: T) => string, separator: string): string =>
  listWithinLimit(items, render, separator, LIST_BUDGET);

const modeLabels: Record<ManagementMode, string> = {
  intervention: "管理介入",
  offboarding: "オフボーディング",
};

export const guidance: Record<EvaluationResult["reason"], string> = {
  AUTHORIZED: "`authors/` の変更に問題はありません。",
  NO_CONTENT_CHANGES:
    "この PR は `authors/` を変更していないため、この確認は必要ありません。通常のレビューを受けてください。",
  EVALUATING: "変更内容を確認しています。",
  INTERVENTION_QUORUM_MISSING:
    "管理介入に必要な Approve がまだそろっていません。「Approve の条件」を確認し、Approve を依頼してください。",
  OFFBOARDING_APPROVAL_MISSING:
    "オフボーディングに必要な Approve がまだそろっていません。「Approve の条件」を確認し、Approve を依頼してください。",
  OFFBOARDING_INVALID_CHANGES: "オフボーディングは meta の editors の変更だけに分けてください。",
  OFFBOARDING_INVALID_TARGET: "削除できるのは、Org に所属しない個人の Editor だけです。",
  EDITOR_APPROVAL_MISSING:
    "Editor の Approve がまだそろっていません。「Approve が必要な人」に現在のコミットを確認してもらい、Approve を依頼してください。",
  TEAM_MAINTAINER_REQUIRED:
    "Team の Maintainer の Approve がまだそろっていません。「Approve が必要な人」に現在のコミットを確認してもらい、Approve を依頼してください。",
  WEBSITE_MEMBER_CONSENT_MISSING:
    "website の変更には、Org Member である Editor の Approve が必要です。その Editor に website の変更を確認してもらい、Approve を依頼してください。",
  CONSENT_MISSING: "PR 本文の確認事項のチェックが完了していません。下の案内に従って PR 本文を直してください。",
  INVALID_EDITORS:
    "各 meta.yaml または meta.yml の editors が空でなく、存在するユーザーまたは公開 Team を重複なく指定しているか確認してください。",
  INVALID_PROFILE: "profile.yaml または profile.yml の YAML と website の値を確認し、修正して push してください。",
  INITIAL_AUTHOR_NOT_EDITOR:
    "新しく作る `authors/<名前>/meta.yaml` の editors に、PR 作成者自身か、作成者が所属する Team を指定してください。",
  NON_CONTENT_CHANGE_FORBIDDEN:
    "`authors/` 以外の変更を PR から取り除いて push してください。設定や検証スクリプトの変更を提案する場合は Issue を作成してください。",
  AUTHOR_ROOT_CASE_CONFLICT:
    "`authors/` の既存のディレクトリと大文字小文字だけが異なる名前は使えません。既存のディレクトリを使うか、別の名前に変更してください。",
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
  INVALID_CHECKBOX: "チェック欄の形式がテンプレートと異なります",
  HISTORY_UNAVAILABLE: "PR 本文の編集履歴を確認できませんでした",
  NOT_AUTHOR: "チェックを入れたのが PR 作成者であることを確認できませんでした",
};

const invalidMergeGuidance: Record<Extract<MergeDecision, { request: "invalid" }>["reason"], string> = {
  INVALID_CHECKBOX: `本文のチェック欄をテンプレートの 1 行（${mergeLabel}）だけにしてからチェックしてください。`,
  HISTORY_UNAVAILABLE:
    "PR 作成者がチェックを外して入れ直してください。編集履歴を確認できない状態が続く場合は管理者に相談してください。",
  NOT_AUTHOR: "PR 作成者がチェックを外して入れ直してください。",
};

// 申請や依頼が無効なときは、理由と直し方を行を分けて警告する
const warning = (title: string, reason: string, action: string): string[] => [
  "> [!WARNING]",
  `> **${title}**`,
  `> 理由: ${reason}`,
  `> ${action}`,
];

const managementReasons: Record<ManagementReason, { reason: string; action: string }> = {
  INVALID_CHECKBOX: {
    reason: "チェック欄の形式がテンプレートと異なります",
    action: "テンプレートの行は書き換えず、チェックだけを入れてください。",
  },
  HISTORY_UNAVAILABLE: {
    reason: "PR 本文の編集履歴を確認できませんでした",
    action: "PR 作成者がチェックを外して入れ直してください。",
  },
  NOT_AUTHOR: {
    reason: "チェックを入れたのが PR 作成者であることを確認できませんでした",
    action: "PR 作成者がチェックを外して入れ直してください。",
  },
  CONFLICT: {
    reason: "管理介入とオフボーディングの両方にチェックが入っています",
    action: "どちらか一方だけにチェックを入れてください。",
  },
  NOT_MEMBER: {
    reason: "PR 作成者が Org Member ではありません",
    action: "管理介入とオフボーディングは Org Member だけが申請できます。チェックを外してください。",
  },
};

const consentReasons: Record<
  Exclude<ConsentStatus["state"], "agreed" | "unchecked">,
  { reason: string; action: string }
> = {
  invalid: {
    reason: "チェック欄の形式がテンプレートと異なります",
    action: "テンプレートの行は書き換えず、チェックだけを入れてください。",
  },
  history_unavailable: {
    reason: "PR 本文の編集履歴を確認できませんでした",
    action: "PR 作成者が 3 つのチェックを外して入れ直してください。",
  },
  not_author: {
    reason: "チェックを入れたのが PR 作成者であることを確認できませんでした",
    action: "PR 作成者本人が、3 つのチェックを外して入れ直してください。",
  },
};

const consentTitle = "確認事項のチェックが完了していません";

// 確認事項は authors/ を変更する PR だけに求める
const consentApplies = (result: EvaluationResult): boolean => (result.facts?.authorRoots.length ?? 0) > 0;

const consentText = ({ consent }: EvaluationResult): string => {
  if (!consent) return "確認できませんでした";
  if (consent.state === "agreed") return `${String(consentLabels.length)} 項目すべてチェック済み`;
  if (consent.state === "unchecked") return "チェックされていない項目があります";

  return "PR 作成者のチェックを確認できません";
};

const consentRows = (result: EvaluationResult): [string, string][] =>
  consentApplies(result) ? [["確認事項", consentText(result)]] : [];

const consentLines = (result: EvaluationResult): string[] => {
  const consent = result.consent;
  if (!consent || consent.state === "agreed" || !consentApplies(result)) return [];
  if (consent.state === "unchecked") {
    return warning(
      consentTitle,
      `未チェックの項目があります（${list(consent.missing, (label) => `「${label}」`, "、")}）`,
      "PR 作成者本人が PR 本文の確認事項を読み、チェックを入れてください。"
    );
  }

  return warning(consentTitle, consentReasons[consent.state].reason, consentReasons[consent.state].action);
};

const editorApprovalReasons = new Set<EvaluationResult["reason"]>([
  "EDITOR_APPROVAL_MISSING",
  "TEAM_MAINTAINER_REQUIRED",
  "WEBSITE_MEMBER_CONSENT_MISSING",
]);

const mergeWaiting: Record<NonNullable<Extract<MergeDecision, { request: "accepted" }>["waiting"]>, string> = {
  DRAFT: "Draft の解除を待っています",
  AUTHORIZATION: "必要な Approve がそろうのを待っています",
  AUTHORS_ONLY: "`authors/` だけの変更になるのを待っています",
  APP_APPROVAL: "App の Approve を待っています",
  CI_UNAVAILABLE: "CI の結果を取得できていません",
  CI_PENDING: "CI の完了を待っています",
  CI_FAILED: "失敗した CI の修正を待っています",
};

const targetsText = (targets: Editor[] | undefined): string => {
  if (targets === undefined) return "確認できませんでした";
  if (targets.length === 0) return "なし";
  return list(targets, (editor) => code(editorName(editor)), ", ");
};

const managementLines = (management: EvaluationResult["management"]): string[] => {
  if (!management) return [];
  if (management.mode === "none") {
    return management.reason
      ? warning(
          "管理介入・オフボーディングの申請は無効です",
          managementReasons[management.reason].reason,
          managementReasons[management.reason].action
        )
      : [];
  }

  return [];
};

const modeRows = (management: EvaluationResult["management"]): [string, string][] => {
  if (!management || management.mode === "none") return [];
  if (management.mode === "intervention") return [["実施内容", modeLabels.intervention]];

  return [
    ["実施内容", modeLabels.offboarding],
    ["削除する Editor", targetsText(management.targets)],
  ];
};

const alerts: Record<EvaluationResult["status"], string> = {
  allowed: "TIP",
  not_applicable: "NOTE",
  waiting: "IMPORTANT",
  rejected: "WARNING",
  error: "CAUTION",
};

const mergeOutcomeTexts: Record<NonNullable<EvaluationResult["mergeOutcome"]>, string> = {
  merged: "マージしました",
  rejected: "GitHub がマージを拒否しました。ブランチの保護ルールや競合を確認してください",
  changed: "マージの直前に PR が更新されたため、マージしていません",
};

const acceptedText = (
  merge: Extract<MergeDecision, { request: "accepted" }>,
  outcome: EvaluationResult["mergeOutcome"]
) => {
  if (merge.waiting) return mergeWaiting[merge.waiting];

  return outcome ? mergeOutcomeTexts[outcome] : "マージを実行しています";
};

const mergeText = (result: EvaluationResult): string => {
  const merge = result.merge;
  if (!merge) return "確認できませんでした";
  if (merge.request === "none") return "依頼なし";
  if (merge.request === "invalid") return `受け付けていません（${invalidMerge[merge.reason]}）`;

  return `受け付けました（${acceptedText(merge, result.mergeOutcome)}）`;
};

// 状態のアラートとは別のブロックにするため、空行で区切られた独立した引用にする
const mergeGuidance = ({ merge, status }: EvaluationResult): string[] => {
  if (merge?.request === "invalid") {
    return warning("自動マージの依頼は無効です", invalidMerge[merge.reason], invalidMergeGuidance[merge.reason]);
  }
  if (merge?.request !== "none" || (status !== "allowed" && status !== "waiting")) return [];

  return [
    "> [!TIP]",
    `> PR 本文のチェック欄（${mergeLabel}）にチェックを付けると、すべてのチェックが成功したときに自動でマージします。`,
  ];
};

const mergeHeadings: Record<NonNullable<Extract<MergeDecision, { request: "accepted" }>["waiting"]>, string> = {
  DRAFT: "Draft を解除するとマージできます",
  AUTHORIZATION: statusLabels.waiting,
  AUTHORS_ONLY: statusLabels.waiting,
  APP_APPROVAL: "App の Approve を待っています",
  CI_UNAVAILABLE: "CI の結果を確認できていません",
  CI_PENDING: "CI の完了を待っています",
  CI_FAILED: "CI の失敗を修正するとマージできます",
};

const mergeOutcomeHeadings: Partial<Record<NonNullable<EvaluationResult["mergeOutcome"]>, string>> = {
  merged: "マージしました",
  rejected: "マージできませんでした",
};

// 認可が通っていても、自動マージの待機や結果によって見出しを変える
const heading = (result: EvaluationResult): string => {
  const outcome = result.mergeOutcome && mergeOutcomeHeadings[result.mergeOutcome];
  if (outcome) return outcome;
  if (result.status === "allowed" && result.facts?.otherPaths.length)
    return "`authors/` 以外の変更にレビューが必要です";
  if (result.status !== "allowed" || result.merge?.request !== "accepted" || !result.merge.waiting) {
    return statusLabels[result.status];
  }

  return mergeHeadings[result.merge.waiting];
};

const identityText = (result: EvaluationResult): string => {
  if (!result.facts) return "確認できませんでした";
  if (result.facts.invalidCommits.length) return "PR 作成者と一致しないコミットがあります";
  if (result.reason === "COMMIT_IDENTITY_MISMATCH") return "確認できるコミットがありません";
  return "すべてのコミットが PR 作成者と一致しました";
};

const details = (title: string, body: string[]): string[] => [
  "<details>",
  `<summary>${title}</summary>`,
  "",
  ...body,
  "",
  "</details>",
];

// 現在の Editor のうち 1 人なら Team のメンバー、Editor の追加や削除なら Team の Maintainer の Approve が必要
const editorText =
  (role: "のメンバー" | "の Maintainer") =>
  (editor: Editor): string =>
    editor.type === "team" ? `${code(editor.slug)} ${role}` : code(editor.login);

const approverRow = (result: EvaluationResult): [string, string] | undefined => {
  const missing = result.details?.missing;
  if (missing?.kind === "all") {
    return ["追加または削除する Editor の全員", list(missing.editors, editorText("の Maintainer"), "、")];
  }
  if (missing) return ["現在の Editor のうち 1 人", list(missing.editors, editorText("のメンバー"), "、")];
  if (result.reason === "WEBSITE_MEMBER_CONSENT_MISSING") return ["Editor のうち 1 人", "Org Member の Editor"];

  return undefined;
};

const approversSection = (result: EvaluationResult): string[] => {
  if (result.status !== "waiting" || !editorApprovalReasons.has(result.reason)) return [];

  const root = result.details?.root;
  const lead = root
    ? `この PR は ${code(`authors/${root}/`)} を変更しているため、その Editor の Approve が必要です。`
    : "この PR で変更する `authors/` のディレクトリの Editor の Approve が必要です。";
  const row = approverRow(result);
  const rows = row ? ["", ...table(["必要な Approve", "対象"], [row], (item) => item)] : [];
  return ["### Approve が必要な人", "", lead, ...rows];
};

const managementConditions: Partial<Record<EvaluationResult["reason"], { lead: string; rows: [string, string][] }>> = {
  INTERVENTION_QUORUM_MISSING: {
    lead: "管理介入には、現在のコミットへの次の Approve が必要です。",
    rows: [
      ["PR 作成者以外の Approve", "4 人以上"],
      ["上のうち Org Owner の Approve", "1 人以上"],
    ],
  },
  OFFBOARDING_APPROVAL_MISSING: {
    lead: "オフボーディングには、現在のコミットへの次の Approve が必要です。",
    rows: [["PR 作成者以外の Org Owner の Approve", "1 人以上"]],
  },
};

const conditionsSection = (result: EvaluationResult): string[] => {
  const condition = result.status === "waiting" ? managementConditions[result.reason] : undefined;
  if (!condition) return [];

  return ["### Approve の条件", "", condition.lead, "", ...table(["条件", "必要な人数"], condition.rows, (row) => row)];
};

const pathsSection = (result: EvaluationResult): string[] => {
  const paths = result.facts?.otherPaths ?? [];
  if (!paths.length) return [];

  const title = `<code>authors/</code> 以外の変更（${String(paths.length)} 件）`;
  const body = [list(paths, (path) => `- ${code(path)}`, "\n")];
  if (result.reason === "NON_CONTENT_CHANGE_FORBIDDEN") {
    body.push(
      "",
      "対象ファイルを base の状態に戻すには `git restore --source origin/main -- <ファイル>` を実行し、変更をコミットして push してください。新規ファイルは削除してコミットしてください。"
    );
    return [`### ${title}`, "", ...body];
  }
  if (result.status === "allowed") {
    return [
      `### ${title}`,
      "",
      ...body,
      "",
      "> [!NOTE]",
      "> `authors/` 以外の変更は自動の確認の対象外のため、App はこの PR を Approve しません。Repository の Write 権限を持つ人にレビューを依頼してください。",
    ];
  }
  return details(title, body);
};

const commitsSection = (result: EvaluationResult): string[] => {
  const bad = result.facts?.invalidCommits ?? [];
  if (!bad.length) return [];

  const body = table(["コミット", "メールアドレス"], bad, (commit) => [
    code(commit.sha),
    commit.authorId === null && commit.authorEmail && /^[^\s@]+@users\.noreply\.github\.com$/i.test(commit.authorEmail)
      ? code(commit.authorEmail)
      : "",
  ]);
  if (bad.some((commit) => commit.authorId === null)) {
    body.push(
      "",
      "GitHub の Settings → Emails でコミットに使ったアドレスを追加するか、GitHub の noreply アドレスでコミットし直して push してください。"
    );
  }
  return details("PR 作成者と一致しないコミット", body);
};

export const authorizationComment = (result: EvaluationResult): string => {
  const rows: [string, string][] = [
    ["状態", `${reasonLabels[result.reason]}（${code(result.reason)}）`],
    ...modeRows(result.management),
    [
      "変更するディレクトリ",
      result.facts
        ? list(result.facts.authorRoots, (root) => code(`authors/${root}/`), ", ") || "なし"
        : "確認できませんでした",
    ],
    ["コミットの本人確認", identityText(result)],
    ...consentRows(result),
    ["自動マージ", mergeText(result)],
  ];
  const sections: string[][] = [
    ["<!-- boarding:authorization -->", `> [!${alerts[result.status]}]`, `> ${guidance[result.reason]}`],
    [
      `## ${heading(result)}`,
      "",
      "| 項目 | 結果 |",
      "| --- | --- |",
      ...rows.map(([name, value]) => `| ${name} | ${cell(value)} |`),
    ],
    mergeGuidance(result),
    consentLines(result),
    managementLines(result.management),
    approversSection(result),
    conditionsSection(result),
    pathsSection(result),
    commitsSection(result),
  ];
  return sections
    .filter((section) => section.length)
    .map((section) => section.join("\n"))
    .join("\n\n");
};

// PR が閉じられた後の管理コメントの本文
export const closedComment = (merged: boolean): string =>
  [
    "<!-- boarding:authorization -->",
    "> [!NOTE]",
    merged ? "> この PR はマージされました。" : "> この PR は閉じられました。再び開くともう一度確認を行います。",
  ].join("\n");

export interface CheckOutput {
  title: string;
  summary: string;
}

export const checkOutput = (result: EvaluationResult): CheckOutput => ({
  title: reasonLabels[result.reason],
  summary:
    result.reason === "EVALUATING"
      ? `${guidance[result.reason]}完了までしばらくお待ちください。`
      : `${guidance[result.reason]}詳しくは PR の管理コメントを確認してください。`,
});
