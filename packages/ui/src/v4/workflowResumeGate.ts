/**
 * Gate that controls whether the session context provides a Resume callback.
 *
 * Pressing Resume actually starts an engine, so no engine-starting path may remain when the rollout is off. The tool-card footer
 * (create-workflow renderer) and turn-end summary card (ConversationWorkflowDigests) both gate their buttons on the callback's presence.
 * Removing it at this single supply point in the session context hides both buttons; the rollout flag need not be passed to each leaf component.
 * The run details panel uses its own sendCommand and has an equivalent gate.
 *
 * Readonly sessions (the share readonly timeline) already do not provide Resume; that rule remains unchanged.
 *
 * Existing runs continue to render normally: cards, summaries, run panel, and artifacts remain visible, but cannot be resumed.
 */
export function resolveWorkflowResumeHandler<THandler>(options: {
  readOnly: boolean | undefined;
  /** Pass false until the rollout snapshot is ready: unknown means unavailable (fail-closed). */
  dynamicWorkflowEnabled: boolean;
  handler: THandler;
}): THandler | undefined {
  if (options.readOnly === true) return undefined;
  if (!options.dynamicWorkflowEnabled) return undefined;
  return options.handler;
}
