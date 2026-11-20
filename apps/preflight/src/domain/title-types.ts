import { ALLOWED_PR_TITLE_TYPES, hasDraftTitleMarker } from "@flightdeck/pr-title";
import picomatch from "picomatch";

export interface TitleTypeRule {
  paths: string[];
  types: string[];
}

export interface TitleTypePolicy {
  types: readonly string[];
  restricted: boolean;
}

export interface TitleTypeInputs {
  rules: TitleTypeRule[] | undefined;
  files: string[];
  filesComplete: boolean;
}

export const isConfigurableTitleType = (type: string): boolean =>
  /^[a-z][a-z0-9_]*$/.test(type) && !hasDraftTitleMarker(`${type}:`);

export const titleTypePolicy = ({ rules, files, filesComplete }: TitleTypeInputs): TitleTypePolicy | undefined => {
  if (!rules || !filesComplete) return undefined;

  const matches = rules.map((rule) => ({ rule, match: picomatch(rule.paths, { dot: true }) }));
  const applicable = matches.filter(({ match }) => files.some((file) => match(file)));
  if (applicable.length === 0) return undefined;

  const covered = files.every((file) => applicable.some(({ match }) => match(file)));
  const types = new Set<string>(covered ? [] : ALLOWED_PR_TITLE_TYPES);
  for (const { rule } of applicable) {
    for (const type of rule.types) types.add(type);
  }

  return { types: [...types], restricted: covered };
};
