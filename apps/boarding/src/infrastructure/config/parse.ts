import { parseDocument } from "yaml";

import { BoardingError } from "../../errors.js";

import type { Editor } from "../../domain/editors.js";
import type { RootFiles } from "../../usecase/evaluate/dependencies.js";

const parse = (text: string): unknown => {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) throw new BoardingError("INVALID_METADATA", "YAML is invalid");

  try {
    return document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (cause) {
    throw new BoardingError("INVALID_METADATA", "YAML is invalid", { cause });
  }
};

const select = (yaml: string | null, yml: string | null): string | null => {
  if (yaml !== null && yml !== null) throw new BoardingError("INVALID_METADATA", "Duplicate YAML files");

  return yaml ?? yml;
};

export const readEditors = (files: RootFiles): Editor[] | null => {
  const text = select(files.metaYaml, files.metaYml);
  if (text === null) return null;

  const data = parse(text);
  if (typeof data !== "object" || data === null || !("editors" in data) || !Array.isArray(data.editors)) {
    throw new BoardingError("INVALID_METADATA", "Editors are invalid");
  }

  const editors: Editor[] = [];
  for (const value of data.editors as unknown[]) {
    if (typeof value !== "string" || !/^(?:team:)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)) {
      throw new BoardingError("INVALID_METADATA", "Editor is invalid");
    }

    const normalized = value.toLowerCase();
    editors.push(
      normalized.startsWith("team:") ? { type: "team", slug: normalized.slice(5) } : { type: "user", login: normalized }
    );
  }

  return editors;
};

export const readWebsite = (files: RootFiles): string | null => {
  try {
    const text = select(files.profileYaml, files.profileYml);
    if (text === null) return null;

    const data = parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new BoardingError("INVALID_METADATA", "Profile is invalid");
    }
    if (!("website" in data) || data.website === null) return null;
    if (typeof data.website !== "string") throw new BoardingError("INVALID_METADATA", "Website is invalid");

    return data.website;
  } catch (error) {
    if (error instanceof BoardingError && error.code === "INVALID_METADATA") {
      throw new BoardingError("INVALID_PROFILE", "Profile is invalid", { cause: error });
    }

    throw error;
  }
};
