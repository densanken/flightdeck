import * as v from "valibot";

export const changedFilesSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
