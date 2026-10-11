import type {
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Transcript rules for a turn started directly by the orchestrator.
 *
 * Prefer launch metadata on turnHeader (authoritative in the live projection), falling back to the same metadata on the user-visible row
 * (cold-recovery hydration also writes it to the userInput row). When metadata is present, the turn's workflowLaunch user row is **not** visible input:
 * its body is a canonical English sentence for the model, and the run card presents the turn. If metadata is absent from both places,
 * fall back to normal rendering (the sentence appears as a bubble).
 */
export function resolveWorkflowLaunchMeta(
  header: TurnHeaderRow | undefined,
  userInputs: readonly UserInputRow[],
): WorkflowLaunchMeta | undefined {
  if (header?.origin !== "workflowLaunch") return undefined;
  return (
    header.workflowLaunch ??
    userInputs.find((row) => row.workflowLaunch !== undefined)?.workflowLaunch
  );
}

/** User row for a launch turn: when metadata is present, the run card represents it; it is omitted from visible input and the stream. */
export function isWorkflowLaunchUserInputRow(row: ConversationRow): boolean {
  return row.kind === "userInput" && row.origin === "workflowLaunch";
}
