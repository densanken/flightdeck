import { composeApp } from "./composition/app.js";

const app = composeApp();

export default { fetch: app.fetch };
