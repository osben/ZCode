/* Structured identifiers returned by the official Server MCP when a tool call is blocked or fails.
 *
 * The server renders this as **JSON text in tool error content** (not `_meta`):
 * `{"error_code":"quota_exceeded","message":"...","request_id":"..."}`
 * See `ToolError.Error()` in zcode-server's `internal/domain/servermcp/toolerror.go`.
 *
 * It lives in shared because it has three consumers in separate packages:
 * - `apps/zcode-cli/packages/core`: parses MCP results and passes the code to the tool result display;
 * - `packages/shared/src/zcode-protocol-v4/rows.ts`: validates the code in the row schema;
 * - `packages/ui`: selects the copy and action for the prompt above the input based on the code.
 * All three must use the same source; otherwise, adding a code could make one side recognize it while another drops it.
 */

/**
 * Codes that cause the client to change UI behavior.
 *
 * The server also has `internal_error`, **intentionally omitted here**: it is the fallback mask for "all other failures"
 * (details stay in server logs). Users cannot resolve it themselves, so it should not trigger a prompt.
 */
export const OFFICIAL_MCP_TOOL_ERROR_CODES = ["quota_exceeded", "coding_plan_required"] as const;

export type OfficialMcpToolErrorCode = (typeof OFFICIAL_MCP_TOOL_ERROR_CODES)[number];

const OFFICIAL_MCP_TOOL_ERROR_CODE_SET = new Set<string>(OFFICIAL_MCP_TOOL_ERROR_CODES);

export interface OfficialMcpToolError {
  code: OfficialMcpToolErrorCode;
  /** Human-readable English text from the server; used only for logs and troubleshooting, while UI copy comes from i18n. */
  message?: string;
  /** Server request id, used to correlate with backend logs. */
  requestId?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parses a structured identifier from tool error text.
 *
 * Strict parsing: the value must be a JSON object and `error_code` must match a known code; otherwise, returns undefined.
 * Do not fall back to matching copy; that would silently break if the server changes a sentence.
 */
export function parseOfficialMcpToolError(text: string): OfficialMcpToolError | undefined {
  const trimmed = text.trim();
  // Quickly rule out most ordinary error text by its first character, so every failure does not reach JSON.parse.
  if (!trimmed.startsWith("{")) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  const code = readString(record.error_code);
  if (!code || !OFFICIAL_MCP_TOOL_ERROR_CODE_SET.has(code)) return undefined;

  const message = readString(record.message);
  const requestId = readString(record.request_id);
  return {
    code: code as OfficialMcpToolErrorCode,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
