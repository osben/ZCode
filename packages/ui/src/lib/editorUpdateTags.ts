/** Generic tag for programmatic updates (setText, setEditorStateJson, etc.) */
export const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";

/**
 * Dedicated tag for restoring history navigation.
 * Previously, PromptHistoryPlugin used the generic PROGRAMMATIC_UPDATE_TAG when restoring history entries,
 * so SlashCommandPlugin’s update listener could not distinguish “the user is typing a slash query” from
 * “history navigation wrote an old entry containing / back into the editor,” causing the panel to reopen and register a COMMAND_PRIORITY_CRITICAL
 * arrow-key handler that consumed all later ArrowUp/ArrowDown events, preventing further history navigation.
 * With a dedicated tag, SlashCommandPlugin can skip history-restoration updates precisely without affecting normal panel behavior when users type /.
 */
export const HISTORY_NAVIGATION_UPDATE_TAG = "zcode-history-navigation";
