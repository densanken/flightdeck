import { logger as honoLogger } from "hono/logger";

import { logger } from "../util/logger.js";

// hono の logger は status を ANSI の色付きで出すため、log を検索しやすいよう色を除く
const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

// request line も共通 logger を通し、他の log と同じ JSON 形式と秘匿化をかける
export const requestLogger = () =>
  honoLogger((message: string) => {
    logger.log("info", { event: "http_request", detail: message.replace(ANSI_ESCAPE, "") });
  });
