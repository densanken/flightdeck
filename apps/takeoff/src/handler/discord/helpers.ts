import { ApplicationCommandOptionType } from "./constants.js";
import { assertNotLoadingSentinel } from "./timeout-budget.js";
import { AppError, errors } from "../../domain/errors.js";

import type { DiscordDependencies } from "./dependencies.js";
import type { AppErrorType } from "../../domain/errors.js";
import type { RegisteredRepository } from "../../domain/repository.js";
import type {
  APIApplicationCommandAutocompleteInteraction,
  APIChatInputApplicationCommandInteraction,
  APIApplicationCommandInteractionDataOption,
  APIApplicationCommandInteractionDataStringOption,
  APIMessageComponentInteraction,
} from "discord-api-types/v10";

export const resolveRepo = async (deps: DiscordDependencies, repoId: string): Promise<RegisteredRepository> => {
  // autocomplete が timeout したときの読み込み中候補は repoId ではないため、案内へ振り分ける
  assertNotLoadingSentinel(repoId);

  const repo = await deps.repositoryAdminUsecase.getRepository(repoId);
  if (!repo) throw errors.repoNotRegistered();
  return repo;
};

export const getStringOption = (
  options: APIApplicationCommandInteractionDataOption[] | undefined,
  name: string
): string | undefined => {
  if (!options) return undefined;
  const opt = options.find((o) => o.name === name);
  if (!isStringOption(opt)) return undefined;
  return opt.value;
};

const isStringOption = (
  option: APIApplicationCommandInteractionDataOption | undefined
): option is APIApplicationCommandInteractionDataStringOption => option?.type === ApplicationCommandOptionType.String;

// Number() は "0x10" や "5e2" も受理するため、10 進数の数字だけを許可する
export const toPrNumber = (value: string): number | null => {
  const prNumber = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return prNumber;
};

export const parsePrNumber = (value: string): number => {
  const prNumber = toPrNumber(value);
  if (prNumber === null) throw errors.invalidRequest("PR 番号が無効です。");
  return prNumber;
};

// embed の文字数上限に収まるだけ行を足し、残りは「…ほか N 件」にまとめる
// 後続の行が残るときだけ、まとめ行の分を空けておく
// text は短い固定文言を前提とし、text 自体が上限を超える場合は考慮しない
export const appendLinesWithinLimit = (text: string, lines: readonly string[], maxLength: number): string => {
  let result = text;
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1;
    const reserved = rest > 0 ? `\n- …ほか ${String(rest)} 件`.length : 0;
    if (result.length + 1 + line.length + reserved > maxLength) {
      return `${result}\n- …ほか ${String(lines.length - i)} 件`;
    }
    result += `\n${line}`;
  }
  return result;
};

export const hasAdminRole = (
  interaction:
    | APIApplicationCommandAutocompleteInteraction
    | APIChatInputApplicationCommandInteraction
    | APIMessageComponentInteraction,
  adminRoleIds: string[]
): boolean => {
  // admin role は guild 単位で付与されるため、member を持たない DM の interaction は許可しない
  // DM は通常この関数へ届く前に許可 guild の検査で弾かれる
  if (!interaction.member) return false;
  const memberRoles = interaction.member.roles;
  return adminRoleIds.some((roleId) => memberRoles.includes(roleId));
};

export const getJapaneseErrorMessage = (err: unknown): string => {
  if (err instanceof AppError) {
    if (err.type === "github_rules_api_unavailable") {
      return `エラーが発生しました: ${err.message}`;
    }
    const messages = {
      repo_not_registered: "指定されたリポジトリは登録されていません。",
      repo_not_found: "指定されたリポジトリが見つからないか、GitHub App からアクセスできません。",
      repo_mismatch:
        "登録済みの名前が別のリポジトリを指しています。管理担当者にリポジトリの登録解除と再登録を依頼してください。",
      pr_not_found: "指定された PR が見つかりません。",
      pr_not_open: "PR が open ではありません。",
      pr_is_draft: "PR が draft です。",
      pr_title_marked_draft: "PR title に draft を示す接頭辞が付いています。",
      invalid_pr_title: `PR title が Conventional PR Title に準拠していません。\nhttps://www.conventionalcommits.org/\n${err.message}`,
      pr_recently_updated: "PR の最終更新から 1 分経過していません。しばらく待ってから再度実行してください。",
      merge_conflict: "マージコンフリクトがあります。",
      merge_blocked: "ブランチプロテクションなどにより GitHub がマージを拒否しました。",
      mergeability_checking: "GitHub がマージ可能性を確認中です。10 秒ほど待ってからもう一度実行してください。",
      checks_pending: "一部の check がまだ実行中です。",
      checks_failed: "一部の check が失敗しています。",
      statuses_pending: "一部の status check がまだ完了していません。",
      statuses_failed: "一部の status が失敗しています。",
      required_checks_policy_missing: "ベースブランチに必須の status check を求める Ruleset が設定されていません。",
      required_checks_missing: "必須の check が未実行か、期待する GitHub App 以外から報告されています。",
      checks_not_registered: "GitHub Actions の check run が見つからないため、マージできません。",
      runs_awaiting_approval:
        "承認待ちの action_required workflow run が残っています。組織メンバー以外が作成した fork PR の CI は自動承認できないため、メンテナが GitHub 上で承認してから再度実行してください。",
      pull_request_changed: "check の再取得中に PR のマージ対象が変わりました。再度実行してください。",
      head_sha_changed: "マージ直前に PR の head SHA が変更されました。",
      merge_cooldown: "同じ PR へのマージを短い間隔で実行しています。しばらく待ってからもう一度実行してください。",
      sync_cooldown: "同じリポジトリへの同期を短い間隔で実行しています。しばらく待ってからもう一度実行してください。",
      role_required: "この操作は管理担当者のみが行うことができます。",
      invalid_request: err.message,
      github_rate_limited: "GitHub API のレート制限に達しました。",
      github_app_permission_missing: "GitHub App の権限が不足しています。",
      unexpected_github_error: "GitHub API との通信に失敗しました。",
      unexpected_discord_error: "Discord API との通信に失敗しました。",
    } satisfies Record<Exclude<AppErrorType, "github_rules_api_unavailable">, string>;
    const message = (messages as Partial<Record<string, string>>)[err.type];
    return message ?? `エラーが発生しました: ${err.message}`;
  }
  return "予期しないエラーが発生しました。";
};
