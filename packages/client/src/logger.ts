/**
 * Renderer-side logging utility.
 * Sends logs to the main process over IPC for centralized writing to ~/.zcode/v2/logs/YYYY-MM-DD.log.
 * Also keeps console output for development debugging.
 */
import { formatLogPrefix } from "@zcode/shared";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

export const logger = {
  info(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.log(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("info", args);
  },
  warn(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.warn(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("warn", args);
  },
  error(...args: unknown[]) {
    if (isRendererProductionBuild()) return;
    console.error(formatLogPrefix("renderer"), ...args);
    window.zcode?.log("error", args);
  },
};
