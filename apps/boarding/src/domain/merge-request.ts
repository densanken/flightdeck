type CheckboxState = "unchecked" | "checked" | "invalid";

const label = "すべてのチェックが成功したら自動マージする";

export const mergeCheckbox = (body: string): CheckboxState => {
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

export const mergeRequested = (versions: BodyVersion[], authorId: number): boolean => {
  const current = versions.at(-1);
  if (!current || mergeCheckbox(current.body) !== "checked") return false;

  const transition = versions.findLastIndex(
    (version, index) =>
      mergeCheckbox(version.body) === "checked" &&
      (index === 0 || mergeCheckbox(versions[index - 1]?.body ?? "") !== "checked")
  );

  return versions[transition]?.editorId === authorId;
};
