// Node's `node:url` as on Windows, for the LSP goldens' Windows section (scripts/fork-rust-agent/lsp-tool.mts).
import * as url from "node:url";

export * from "node:url";
export const fileURLToPath = (value) => url.fileURLToPath(value, { windows: true });
export const pathToFileURL = (value) => url.pathToFileURL(value, { windows: true });
