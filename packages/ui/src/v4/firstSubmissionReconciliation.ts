// Reconciliation of an unresolved first submission (specs/first-submission-instant-ux.md,
// Reconciliation of unresolved outcomes). The pane that holds the persisted record decides from
// durable Host facts first and only then from the original command id: an `accepted` ACK does
// not survive a CLI restart, so a query `unknown` alone never proves the input was not admitted.
import { useEffect, useRef, useState } from "react";
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
  const factsKey = `${commandId}:${status}:${hostPreparing}:${held}`;
  // One query in flight per facts; a Host revision never cancels or repeats it. After it settles
  // undecided or transient, one follow-up runs only if the revision advanced meanwhile.
  const latestFactsRef = useRef(factsKey);
  latestFactsRef.current = factsKey;
  const inFlightRef = useRef<string | null>(null);
  const attemptRef = useRef<{ factsKey: string; revision: number | undefined; decided: boolean }>(
    null,
  );
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (!enabled || !sessionId || !submissionId) return;
    if (active || !snapshotLive) return;
    if (status !== "sending" && status !== "unknown") return;
    // `report` only for identity-backed decisions (this command's query result or its own row):
    // registry listeners such as a Remove hold or the ledger clear the user's text on "accepted".
    const apply = (next: Extract<FirstSubmissionStatus, "sending" | "failed">, report: boolean) => {
      attemptRef.current = { factsKey, revision: hostRevision, decided: true };
      if (report && commandId)
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
    // The copy's own row is identity evidence whenever it appears, even after an undecided query.
    if (matchedRow) {
      if (attemptRef.current?.factsKey !== `${factsKey}:row`) {
        apply("sending", true);
        attemptRef.current = { factsKey: `${factsKey}:row`, revision: hostRevision, decided: true };
      }
      return;
    }
    const attempt = attemptRef.current;
    if (attempt?.factsKey === factsKey && attempt.decided) return;
    // A record is cleared by the pane's reconcile predicate (fresh-session fallback included).
    if (realRowProjected && !held) return;
    // A record without an id has nothing to query: only the reserved marker can reconcile it, and
    // that is not identity evidence (it keeps the record synchronizing, never decides a held copy).
    if (!commandId) {
      if (!held && markerProvesAdmission && !hostPreparing) apply("sending", false);
      return;
    }
    // Ask the ledger about this record's own id before consulting the marker. The bridge sets the
    // marker on any sendText into a preparing session (spec: Owner of the frozen input), so an active
    // marker cannot prove that this id was admitted.
    if (inFlightRef.current === factsKey) return;
    if (attempt?.factsKey === factsKey && attempt.revision === hostRevision) return;
    inFlightRef.current = factsKey;
    const attemptRevision = hostRevision;
    const finish = (decided: boolean) => {
      if (inFlightRef.current === factsKey) inFlightRef.current = null;
      if (!decided) attemptRef.current = { factsKey, revision: attemptRevision, decided: false };
      // Re-run once to see whether the revision advanced during the flight.
      setSettled((value) => value + 1);
    };
    void queryRef.current({ commands: [{ sessionId, commandId }] }).then(
      (result) => {
        if (!aliveRef.current || latestFactsRef.current !== factsKey) {
          if (inFlightRef.current === factsKey) inFlightRef.current = null;
          return;
        }
        const item = result.results.find((entry) => entry.key.commandId === commandId);
        const next = decideFirstSubmissionFromQuery(item?.result);
        // "unknown" is no evidence for this id (a CLI restart forgets accepted commands). A reserved
        // record whose marker flipped takes the marker decision, unreported. A held copy of such a
        // record stays held. Worktree markers never carry this signal (spec: residual risk).
        const markerDecides = item?.result === "unknown" && markerProvesAdmission && !hostPreparing;
        const undecided = !next || (markerDecides && held);
        if (!undecided) {
          if (markerDecides) apply("sending", false);
          else apply(next, true);
        }
        finish(!undecided);
      },
      (error: unknown) => {
        // Nothing decided: re-checked when the Host revision advances or connectivity returns.
        logger.warn("[first-submission] outcome query failed; keeping the record", error);
        if (!aliveRef.current || latestFactsRef.current !== factsKey) {
          if (inFlightRef.current === factsKey) inFlightRef.current = null;
          return;
        }
        finish(false);
      },
    );
  }, [
    active,
    commandId,
    enabled,
    factsKey,
    settled,
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
