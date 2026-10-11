import { HISTORY_NAVIGATION_UPDATE_TAG } from "./editorUpdateTags.js";

/**
 * Determine whether SlashCommandPlugin’s update listener should process this editor update.
 *
 * Return false when restoring history navigation so the panel does not register its COMMAND_PRIORITY_CRITICAL arrow-key handler
 * and consume subsequent history-navigation keys. Return true for other updates (user input and other programmatic updates).
 */
export function shouldSlashPanelProcessUpdate(tags: ReadonlySet<string>): boolean {
  return !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}
