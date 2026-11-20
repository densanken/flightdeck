import { chooseConfig, parseConfigDocument } from "@flightdeck/rules";
import { configObject } from "@flightdeck/validation";
import * as v from "valibot";

import { isConfigurableTitleType } from "../../domain/title-types.js";

import type { TitleTypeRule } from "../../domain/title-types.js";
import type { ConfigFile } from "@flightdeck/rules";

const schema = v.pipe(
  configObject,
  v.strictObject({
    "title-types": v.array(
      v.pipe(
        configObject,
        v.strictObject({
          paths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
          types: v.pipe(v.array(v.pipe(v.string(), v.check(isConfigurableTitleType))), v.minLength(1)),
        })
      )
    ),
  })
);

export const readTitleTypeRules = (files: ConfigFile[]): TitleTypeRule[] | undefined => {
  const file = chooseConfig(files);
  if (!file) return undefined;

  const document = parseConfigDocument(file.text);
  if (document === null || !("preflight" in document)) return undefined;

  const parsed = v.safeParse(schema, document.preflight);
  if (!parsed.success) {
    const path = parsed.issues[0].path?.map((item) => String(item.key)).join(".") ?? "";
    throw new Error(`Invalid preflight configuration at preflight.${path}`);
  }

  return parsed.output["title-types"];
};
