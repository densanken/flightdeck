import { composeApp } from "./composition/app.js";

import type { Env } from "./env.js";

const app = composeApp();
export default {
  fetch: (request: Request, env: Env["Bindings"], ctx: ExecutionContext) => app.fetch(request, env, ctx),
};
