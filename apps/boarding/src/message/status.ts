import type { EvaluationResult } from "../usecase/evaluate/interface.js";

export const statusLabels: Record<EvaluationResult["status"], string> = {
  allowed: "マージできます",
  waiting: "まだマージできません",
  rejected: "マージできません",
  not_applicable: "記事以外の変更です",
  error: "確認できませんでした",
};

export const reasonLabels: Record<EvaluationResult["reason"], string> = {
  AUTHORIZED: "authors/ の変更に問題はありません",
  NO_CONTENT_CHANGES: "authors/ の変更はありません",
  RENOVATE_UPDATE: "Renovate による依存関係の更新です",
  EVALUATING: "変更内容を確認しています",
  INTERVENTION_QUORUM_MISSING: "管理介入に必要な Approve が足りません",
  OFFBOARDING_APPROVAL_MISSING: "オフボーディングに必要な Approve が足りません",
  OFFBOARDING_INVALID_CHANGES: "オフボーディングの変更内容が正しくありません",
  OFFBOARDING_INVALID_TARGET: "オフボーディングの削除対象が正しくありません",
  EDITOR_APPROVAL_MISSING: "Editor の Approve が必要です",
  TEAM_MAINTAINER_REQUIRED: "Team の Maintainer の Approve が必要です",
  WEBSITE_MEMBER_CONSENT_MISSING: "website の変更に Org Member の Approve が必要です",
  CONSENT_MISSING: "PR 本文の確認事項のチェックが完了していません",
  INVALID_EDITORS: "editors の設定に問題があります",
  INVALID_PROFILE: "プロフィールの設定に問題があります",
  INITIAL_AUTHOR_NOT_EDITOR: "PR 作成者が editors に含まれていません",
  NON_CONTENT_CHANGE_FORBIDDEN: "authors/ 以外の変更が含まれています",
  AUTHOR_ROOT_CASE_CONFLICT: "ディレクトリ名が既存の名前と重なっています",
  COMMIT_IDENTITY_MISMATCH: "コミットの作者が PR 作成者と一致しません",
  INCOMPLETE_DATA: "情報を完全に取得できませんでした",
  API_ERROR: "GitHub の情報を取得できませんでした",
  YAML_SIZE_LIMIT: "YAML のサイズが上限を超えています",
  SUBREQUEST_LIMIT: "確認する内容が多すぎます",
};
