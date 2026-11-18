import { githubId } from "@flightdeck/validation";
import * as v from "valibot";

const common = {
  deliveryId: v.string(),
  installationId: githubId,
};

export const boardingMessageSchema = v.variant("event", [
  v.object({ ...common, event: v.literal("evaluate"), number: githubId }),
  v.object({
    ...common,
    event: v.literal("ci-completed"),
    sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
    repositoryId: githubId,
  }),
  v.object({ ...common, event: v.picklist(["push", "permissions-changed"]) }),
]);

export type BoardingMessage = v.InferOutput<typeof boardingMessageSchema>;
