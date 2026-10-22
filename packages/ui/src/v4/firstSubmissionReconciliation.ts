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
  snapshotLive,
  hostPreparing,
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
  realRowProjected: boolean;
  /** The bound session's snapshot has arrived, so `hostPreparing` is a Host fact. */
  snapshotLive: boolean;
  /** The Host still reports `submissionPreparation`: the frozen input was not admitted yet. */
  hostPreparing: boolean;
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
  useEffect(() => {
    if (!enabled || !sessionId || !submissionId || !commandId) return;
    if (active || !snapshotLive) return;
    if (status !== "sending" && status !== "unknown") return;
    const apply = (next: Extract<FirstSubmissionStatus, "sending" | "failed">) => {
      // Listeners (a Remove hold, the unsettled ledger) learn the decision from the registry; the
      // record, when there is one, is written here — the held copy is owned by its composer.
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
    if (realRowProjected) {
      // A record is cleared by the pane's reconcile predicate; a held copy is settled here.
      if (held) apply("sending");
      return;
    }
    // The Host marks a reserved submission's preparation active when a sendText executes. Known
    // limitation: the bridge does so for any sendText, so a foreign input sent from another
    // client into the preparing session also satisfies this (spec: CLI follow-up).
    if (markerProvesAdmission && !hostPreparing) {
      apply("sending");
      return;
    }
    let current = true;
    void queryRef.current({ commands: [{ sessionId, commandId }] }).then(
      (result) => {
        if (!current) return;
        const item = result.results.find((entry) => entry.key.commandId === commandId);
        const next = decideFirstSubmissionFromQuery(item?.result);
        if (next) apply(next);
      },
      (error: unknown) => {
        // Nothing decided: the record stays as it is and is checked again on the next input change.
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
    held,
    hostPreparing,
    markerProvesAdmission,
    realRowProjected,
    sessionId,
    snapshotLive,
    status,
    submissionId,
    workspaceIdentity,
    workspacePath,
  ]);
}
