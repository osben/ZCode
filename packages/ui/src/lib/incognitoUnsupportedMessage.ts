import {
  INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
  INCOGNITO_UNSUPPORTED_ERROR,
} from "@zcode/shared";

/** Toast message ids for a rejected incognito create (specs/incognito-session.md, "Errors"). */
export type IncognitoUnsupportedMessageId =
  | "chat.incognito.agentOutdated"
  | "chat.incognito.unsupported";

/**
 * Maps a send failure to the incognito toast, or `null` when the failure is not an incognito gate
 * failure. The gate codes travel as the error message (`channelServer` forwards `error.message`
 * unchanged), so the subcode is matched as a substring of the detail.
 */
export function incognitoUnsupportedMessageId(
  detail: string,
): IncognitoUnsupportedMessageId | null {
  if (!detail.includes(INCOGNITO_UNSUPPORTED_ERROR)) return null;
  // A stale agent build can be fixed by restarting or updating; the other gate failures mean the
  // agent has no incognito support at all.
  return detail.includes(INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR)
    ? "chat.incognito.agentOutdated"
    : "chat.incognito.unsupported";
}
