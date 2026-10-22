// Reconciliation of an unresolved first submission (specs/first-submission-instant-ux.md,
// Reconciliation of unresolved outcomes). The pane that holds the persisted record decides from
// durable Host facts first and only then from the original command id: an `accepted` ACK does
// not survive a CLI restart, so a query `unknown` alone never proves the input was not admitted.
import { useEffect, useRef } from "react";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { updateV4FirstSubmission, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

type FirstSubmissionStatus = NonNullable<V4ComposerDraft["firstSubmission"]>["status"];
type CommandQueryOutcome = CommandsQueryResult["results"][number]["result"];

/** Status for a still-preparing session from the original command's query result; null keeps it. */
export function decideFirstSubmissionFromQuery(
  result: CommandQueryOutcome | undefined,
): Extract<FirstSubmissionStatus, "sending" | "failed"> | null {
  if (result === undefined) return null;
  if (result === "unknown") return "failed";
  if (result.status === "accepted" || result.status === "duplicate") return "sending";
  if (result.status === "failed" && result.reasonCode === "fault.command.queryUnavailable")
    return null;
  return "failed";
}

export function useFirstSubmissionReconciliation({
  enabled,
  workspacePath,
  workspaceIdentity,
  sessionId,
  firstSubmission: recordFirstSubmission,
  heldFirstSubmission,
  active,
  realRowProjected,
  commandRowProjected,
  snapshotLive,
  hostPreparing,
  hostRevision,
  queryCommands,
}: {
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** The bound session holding the record; draft-scope records have no Host command to query. */
  sessionId: string | null;
  firstSubmission: V4ComposerDraft["firstSubmission"];
  /**
   * The session composer's restored submission after Remove on an unresolved record. It has no
   * record of its own; the decision reaches its owner (the composer) only through the registry.
   */
  heldFirstSubmission?: V4ComposerDraft["firstSubmission"];
  /** A live send chain in this renderer owns the record and settles it itself. */
  active: boolean;
  /** The record's reconcile predicate matched (strict id or the fresh-session fallback). */
  realRowProjected: boolean;
  /** A visible realUser row carries exactly this command id (identity evidence). */
  commandRowProjected: (commandId: string) => boolean;
  /** The bound session's snapshot has arrived, so `hostPreparing` is a Host fact. */
  snapshotLive: boolean;
  /** The Host still reports `submissionPreparation`: the frozen input was not admitted yet. */
  hostPreparing: boolean;
  /** Advances with every Host state change: re-checks after a transient query failure. */
  hostRevision: number | undefined;
  queryCommands: (params: CommandsQueryParams) => Promise<CommandsQueryResult>;
}): void {
  const queryRef = useRef(queryCommands);
  queryRef.current = queryCommands;
  const held =
    !recordFirstSubmission &&
    (heldFirstSubmission?.status === "sending" || heldFirstSubmission?.status === "unknown");
  const firstSubmission = recordFirstSubmission ?? (held ? heldFirstSubmission : undefined);
  const submissionId = firstSubmission?.submissionId;
  const commandId = firstSubmission?.commandId;
  const status = firstSubmission?.status;
  // Only a reserved (plain) submission's marker flips at its sendText; a worktree marker completes
  // at activation, before any input, so its absence proves nothing about admission.
  const markerProvesAdmission = Boolean(firstSubmission?.reservation);
  const matchedRow = commandId ? commandRowProjected(commandId) : false;
  // A decided attempt is not repeated for the same facts; only a transient failure (query threw or
  // was unavailable) re-queries, when the Host revision advances or connectivity returns.
  const settledFactsRef = useRef<string | null>(null);
  const factsKey = `${commandId}:${status}:${hostPreparing}:${held}`;
  useEffect(() => {
    if (!enabled || !sessionId || !submissionId || !commandId) return;
    if (active || !snapshotLive) return;
    if (status !== "sending" && status !== "unknown") return;
    if (settledFactsRef.current === factsKey) return;
    // `report` only for identity-backed decisions (this command's query result or its own row):
    // registry listeners such as a Remove hold or the ledger clear the user's text on "accepted".
    const apply = (next: Extract<FirstSubmissionStatus, "sending" | "failed">, report: boolean) => {
      settledFactsRef.current = factsKey;
      if (report)
        pendingCommandRegistry.reportReconciledResolution(
          commandId,
          next === "sending" ? "accepted" : "failed",
        );
      if (held || next === status) return;
      try {
        updateV4FirstSubmission(workspacePath, workspaceIdentity, submissionId, { status: next });
      } catch (error) {
        logger.warn("[first-submission] could not persist the reconciled outcome", error);
      }
    };
    if (matchedRow) {
      apply("sending", true);
      return;
    }
    // A record is cleared by the pane's reconcile predicate (fresh-session fallback included).
    if (realRowProjected && !held) return;
    // The Host marks a reserved submission's preparation active when a sendText executes. Known
    // limitation: the bridge does so for any sendText, so this is not identity evidence — it only
    // keeps a record synchronizing and never decides a held copy (spec: CLI follow-up).
    if (!held && markerProvesAdmission && !hostPreparing) {
      apply("sending", false);
      return;
    }
    let current = true;
    void queryRef.current({ commands: [{ sessionId, commandId }] }).then(
      (result) => {
        if (!current) return;
        const item = result.results.find((entry) => entry.key.commandId === commandId);
        const next = decideFirstSubmissionFromQuery(item?.result);
        if (!next) return;
        // For a reserved submission whose marker already flipped, a query "unknown" is no evidence
        // either way (another input may have flipped it, and a CLI restart forgets accepted
        // commands): keep holding. Worktree markers never carry this signal (spec: residual risk).
        if (
          next === "failed" &&
          item?.result === "unknown" &&
          markerProvesAdmission &&
          !hostPreparing
        ) {
          settledFactsRef.current = factsKey;
          return;
        }
        apply(next, true);
      },
      (error: unknown) => {
        // Nothing decided: re-checked when the Host revision advances or connectivity returns.
        logger.warn("[first-submission] outcome query failed; keeping the record", error);
      },
    );
    return () => {
      current = false;
    };
  }, [
    active,
    commandId,
    enabled,
    factsKey,
    held,
    hostPreparing,
    hostRevision,
    markerProvesAdmission,
    matchedRow,
    realRowProjected,
    sessionId,
    snapshotLive,
    status,
    submissionId,
    workspaceIdentity,
    workspacePath,
  ]);
}
