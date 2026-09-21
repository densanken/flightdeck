const AUTO_ASSIGN_ACTIONS = new Set(["opened", "reopened"]);
// converted_to_draft を落とすと、gate から外れた PR の status が残り、同じ head の別 PR を塞ぎ続ける
const TITLE_VALIDATION_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "closed",
]);

export const triggersAutoAssign = (action: string): boolean => AUTO_ASSIGN_ACTIONS.has(action);

export const triggersTitleValidation = (action: string, titleChanged: boolean): boolean =>
  TITLE_VALIDATION_ACTIONS.has(action) || (action === "edited" && titleChanged);
