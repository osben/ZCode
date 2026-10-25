/**
 * Vocabulary for the driver's **observations** of an ask: usage ({@link AskStats}) and progress
 * ({@link AskProgress}), the two halves of one turn-completion report—one is accounting, the other
 * answers “is it still moving?”
 *
 * Split from types.ts for the same reason as imported-cache-types.ts: that contract reached
 * oxlint's max-lines limit. The public surface is unchanged—types.ts re-exports every name here, so
 * import paths remain `./types.js`.
 */

/** Usage statistics reported by the driver each time an ask completes. */
export interface AskStats {
  tokens: number;
  toolCalls: number;
  turns: number;
  /**
   * Number of calls that **read or changed the external world**: file reads, commands, network access.
   * Excludes protocol tools that only return results or questions to the engine (`submit_result`,
   * `escalate`), so this is 0 for a typed ask that only answers. Such an ask is **pure**, depending
   * only on instructions and transcript prefix, and remains cacheable after the import cache closes.
   * Old journal rows do not have this key and are treated conservatively as having touched the world.
   */
  worldToolCalls?: number;
}

/**
 * Character limit (240) for `instructionsHead` on `node-queued`. Enough for one or two sentences to
 * describe the ask without duplicating the full instruction in the event table; the full text is in
 * `dwf_node.input_json`.
 */
export const INSTRUCTIONS_HEAD_MAX_CHARS = 240;

/** Character limit (64) for `lastTool.name` on `node-progress`: tool name, not description. */
export const LAST_TOOL_NAME_MAX_CHARS = 64;

/**
 * Character limit (120) for `lastTool.target` on `node-progress`: a human-readable clue (file path /
 * command prefix), not the argument itself—the argument can contain anything, and this event is
 * read by the primary agent and rendered by the GUI.
 */
export const LAST_TOOL_TARGET_MAX_CHARS = 120;

/**
 * Most recently observed tool call (`lastTool` in {@link AskProgress}).
 * `target` is a human-readable **clue**, not the argument: file tools provide a path, Bash provides
 * the command prefix, and it is absent if it cannot be identified.
 */
export interface AskLastTool {
  /** Tool name, ≤ {@link LAST_TOOL_NAME_MAX_CHARS}. */
  name: string;
  /** Short target, ≤ {@link LAST_TOOL_TARGET_MAX_CHARS}; absent when unknown (do not synthesize a placeholder). */
  target?: string;
}

/**
 * Progress for an ask **at the time a turn resolves**.
 * Along with {@link AskStats}, this is one half of the same driver report: stats is accounting
 * (tokens), and progress answers “is it still moving?”
 */
export interface AskProgress {
  /** Number of turns resolved within this ask, starting at 1 (includes nudge rounds; excludes repair rounds, which do not end a turn). */
  turn: number;
  /** Cumulative tool-call count within this ask, using the same counter as {@link AskStats.toolCalls}. */
  toolCalls: number;
  lastTool?: AskLastTool;
}
