// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { useFirstSubmissionReconciliation } from "@/v4/firstSubmissionReconciliation.js";

const WORKSPACE = "/first-submission-reconciliation-hook";
const SCOPE = "session-reconciled";
const SUBMISSION = "submission-reconciled";
const SESSION = "session-reconciled";
const OWN_COMMAND = "cmd-own-sendtext";

type FirstSubmission = NonNullable<V4ComposerDraft["firstSubmission"]>;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function storedRecord(firstSubmission: FirstSubmission) {
  persistV4ComposerDraft(WORKSPACE, undefined, SCOPE, { text: "frozen text", firstSubmission });
  return firstSubmission;
}

function statusOnDisk(): string | undefined {
  return readV4ComposerDraft(WORKSPACE, undefined, SCOPE)?.firstSubmission?.status;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;
type LedgerAnswer = CommandsQueryResult["results"][number]["result"];

/** The ledger's answer for every queried key (the record's own id in these tests). */
function ledgerAnswer(result: LedgerAnswer) {
  return vi.fn<QueryCommands>(async (params) => ({
    results: params.commands.map((key) => ({ key, result })),
  }));
}

function renderReconciliation(
  record: FirstSubmission,
  options: {
    hostPreparing: boolean;
    queryCommands: QueryCommands;
  },
) {
  return renderHook(
    (props: { firstSubmission: FirstSubmission; hostPreparing: boolean }) =>
      useFirstSubmissionReconciliation({
        enabled: true,
        workspacePath: WORKSPACE,
        workspaceIdentity: undefined,
        sessionId: SESSION,
        firstSubmission: props.firstSubmission,
        active: false,
        realRowProjected: false,
        commandRowProjected: () => false,
        snapshotLive: true,
        hostPreparing: props.hostPreparing,
        hostRevision: 1,
        queryCommands: options.queryCommands,
      }),
    { initialProps: { firstSubmission: record, hostPreparing: options.hostPreparing } },
  );
}

describe("first-submission reconciliation asks the ledger for the record's own id", () => {
  it("a rejected own id with an active marker settles failed, not sending (marker never wins)", async () => {
    const record = storedRecord({
      submissionId: SUBMISSION,
      ownerKey: SESSION,
      status: "sending",
      commandId: OWN_COMMAND,
      reservation: { sessionId: SESSION, commandId: "cmd-reservation" },
    });
    const report = vi.spyOn(pendingCommandRegistry, "reportReconciledResolution");
    const queryCommands = ledgerAnswer({
      commandId: OWN_COMMAND,
      status: "rejected",
      reasonCode: "guard.inputRejected",
      revisionAtDecision: 1,
    });

    // Marker active: no submissionPreparation in the snapshot.
    renderReconciliation(record, { hostPreparing: false, queryCommands });

    await waitFor(() => expect(statusOnDisk()).toBe("failed"));
    expect(queryCommands).toHaveBeenCalledWith({
      commands: [{ sessionId: SESSION, commandId: OWN_COMMAND }],
    });
    expect(report).toHaveBeenCalledWith(OWN_COMMAND, "failed");
  });

  it("an admitted own id settles sending and is reported as accepted", async () => {
    const record = storedRecord({
      submissionId: SUBMISSION,
      ownerKey: SESSION,
      status: "unknown",
      commandId: OWN_COMMAND,
      reservation: { sessionId: SESSION, commandId: "cmd-reservation" },
    });
    const report = vi.spyOn(pendingCommandRegistry, "reportReconciledResolution");
    const queryCommands = ledgerAnswer({
      commandId: OWN_COMMAND,
      status: "accepted",
      revisionAtDecision: 1,
    });

    renderReconciliation(record, { hostPreparing: false, queryCommands });

    await waitFor(() => expect(statusOnDisk()).toBe("sending"));
    expect(queryCommands).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(OWN_COMMAND, "accepted");
  });

  it("a record without an id keeps the marker decision and asks nothing", async () => {
    const record = storedRecord({
      submissionId: SUBMISSION,
      ownerKey: SESSION,
      status: "unknown",
      reservation: { sessionId: SESSION, commandId: "cmd-reservation" },
    });
    const report = vi.spyOn(pendingCommandRegistry, "reportReconciledResolution");
    const queryCommands = ledgerAnswer("unknown");

    renderReconciliation(record, { hostPreparing: false, queryCommands });

    await waitFor(() => expect(statusOnDisk()).toBe("sending"));
    expect(queryCommands).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("an unknown own id with the marker flipped keeps the marker decision, unreported", async () => {
    const record = storedRecord({
      submissionId: SUBMISSION,
      ownerKey: SESSION,
      status: "unknown",
      commandId: OWN_COMMAND,
      reservation: { sessionId: SESSION, commandId: "cmd-reservation" },
    });
    const report = vi.spyOn(pendingCommandRegistry, "reportReconciledResolution");
    const queryCommands = ledgerAnswer("unknown");

    renderReconciliation(record, { hostPreparing: false, queryCommands });

    await waitFor(() => expect(statusOnDisk()).toBe("sending"));
    expect(queryCommands).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("an unknown own id while the frozen input is still preparing fails", async () => {
    const record = storedRecord({
      submissionId: SUBMISSION,
      ownerKey: SESSION,
      status: "sending",
      commandId: OWN_COMMAND,
      reservation: { sessionId: SESSION, commandId: "cmd-reservation" },
    });
    const report = vi.spyOn(pendingCommandRegistry, "reportReconciledResolution");
    const queryCommands = ledgerAnswer("unknown");

    renderReconciliation(record, { hostPreparing: true, queryCommands });

    await waitFor(() => expect(statusOnDisk()).toBe("failed"));
    expect(report).toHaveBeenCalledWith(OWN_COMMAND, "failed");
  });
});
