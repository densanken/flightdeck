type CheckboxState = "unchecked" | "checked" | "invalid";

export const mergeLabel = "すべてのチェックが成功したら自動マージする";

export const mergeCheckbox = (body: string, label: string): CheckboxState => {
  const candidates = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("[") && line.includes(label, line.indexOf("[")));

  if (candidates.length === 0) return "unchecked";
  if (candidates.length !== 1) return "invalid";

  const line = candidates[0];
  if (line === `- [ ] ${label}`) return "unchecked";
  if (line === `- [x] ${label}` || line === `- [X] ${label}`) return "checked";
  return "invalid";
};

export interface BodyVersion {
  body: string;
  editorId: number;
}

export const mergeRequested = (versions: BodyVersion[], authorId: number, label: string): boolean => {
  const current = versions.at(-1);
  if (!current || mergeCheckbox(current.body, label) !== "checked") return false;

  const transition = versions.findLastIndex(
    (version, index) =>
      mergeCheckbox(version.body, label) === "checked" &&
      (index === 0 || mergeCheckbox(versions[index - 1]?.body ?? "", label) !== "checked")
  );

  return versions[transition]?.editorId === authorId;
};

export const consentLabels = [
  "私は CCS のメンバーまたは OB/OG です",
  "投稿内容は公序良俗に反しません",
  "ガイドライン違反やその他運営上の都合により、管理者側で削除や非公開化などの対応を行うことに同意します",
];

export type ConsentStatus =
  | { state: "agreed" }
  | { state: "unchecked"; missing: string[] }
  | { state: "invalid" | "history_unavailable" | "not_author" };

export const needsConsentHistory = (body: string): boolean =>
  consentLabels.some((label) => mergeCheckbox(body, label) === "checked");

export const consentStatus = (body: string, versions: BodyVersion[] | null, authorId: number): ConsentStatus => {
  const checkboxes = consentLabels.map((label) => ({ label, state: mergeCheckbox(body, label) }));
  if (checkboxes.some(({ state }) => state === "invalid")) return { state: "invalid" };

  const missing = checkboxes.filter(({ state }) => state === "unchecked").map(({ label }) => label);
  if (missing.length > 0) return { state: "unchecked", missing };

  if (!versions || versions.at(-1)?.body !== body) return { state: "history_unavailable" };
  if (!consentLabels.every((label) => mergeRequested(versions, authorId, label))) return { state: "not_author" };

  return { state: "agreed" };
};
