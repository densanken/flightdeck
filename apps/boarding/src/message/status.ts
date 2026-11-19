import type { EvaluationResult } from "../usecase/evaluate/interface.js";

export const statusLabels: Record<EvaluationResult["status"], string> = {
  allowed: "認可済み",
  waiting: "承認待ち",
  rejected: "認可されませんでした",
  not_applicable: "認可対象外",
  error: "確認できませんでした",
};

export const reasonLabels: Record<EvaluationResult["reason"], string> = {
  AUTHORIZED: "必要な同意を確認済み",
  NO_CONTENT_CHANGES: "著者の変更なし",
  EVALUATING: "評価中",
  INTERVENTION_QUORUM_MISSING: "管理介入の承認不足",
  OFFBOARDING_APPROVAL_MISSING: "Offboarding の承認不足",
  OFFBOARDING_INVALID_CHANGES: "Offboarding の変更が不正",
  OFFBOARDING_INVALID_TARGET: "Offboarding の対象が不正",
  EDITOR_APPROVAL_MISSING: "Editor の承認不足",
  TEAM_MAINTAINER_REQUIRED: "Team Maintainer の承認不足",
  WEBSITE_MEMBER_CONSENT_MISSING: "website 変更への同意不足",
  INVALID_EDITORS: "Editor の設定が不正",
  INVALID_PROFILE: "プロフィールが不正",
  INITIAL_AUTHOR_NOT_EDITOR: "PR 作成者が Editor に含まれていない",
  NON_CONTENT_CHANGE_FORBIDDEN: "authors 以外の変更を含む",
  AUTHOR_ROOT_CASE_CONFLICT: "著者名が既存の名前と重複",
  COMMIT_IDENTITY_MISMATCH: "コミットの作者が一致しない",
  INCOMPLETE_DATA: "データの取得が不完全",
  API_ERROR: "GitHub の情報を取得できない",
  YAML_SIZE_LIMIT: "YAML のサイズ超過",
  SUBREQUEST_LIMIT: "API 呼び出しの上限超過",
};
