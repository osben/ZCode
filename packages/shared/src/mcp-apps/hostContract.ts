/**
 * Second half of the MCP Apps host-side contract: ui/download-file items, tool-input / tool-result payloads, and the host-provided titleBar plus style variables.
 * hostInfo / hostCapabilities / hostContext reuse the official SDK's `McpUiHostCapabilities` / `McpUiHostContext` instead of redefining them.
 */

/**
 * One item of `ui/download-file { contents }` — either an MCP-standard EmbeddedResource (inline
 * text / blob) or a ResourceLink (uri only; the host fetches the content via the same plugin
 * server's `resources/read`).
 */
export type McpAppsDownloadFileItem =
  | {
      type: "resource";
      resource: { uri: string; name?: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };
/** Per-call item limit and per-file decoded size limit for ui/download-file (same 50 MiB as the desktop saveFile). */
export const MCP_APPS_DOWNLOAD_FILE_MAX_ITEMS = 16;
export const MCP_APPS_DOWNLOAD_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** MCP content block (text / image / resource…); the host only passes it through and does not interpret non-text blocks. */
export type McpAppsContentBlock = Record<string, unknown>;

/** Payloads of `ui/notifications/tool-input` and `tool-result` (same shape as the official SDK notification params). */
export interface McpAppsToolInputPayload {
  arguments?: Record<string, unknown>;
}
export interface McpAppsToolResultPayload {
  content?: McpAppsContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Panel header the host draws above the page viewport; provided only in fullscreen (hostContext allows extra keys). */
export interface McpAppsHostTitleBar {
  height: number;
  leftInset: number;
  viewportLeftInset: number;
}
/** Standard MCP Apps style variables (key names in the official `McpUiStyleVariableKey`); values are CSS text the page can use directly. */
export type McpAppsStyleVariables = Record<string, string>;
