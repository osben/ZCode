// Source-contract coverage for the prepared-session worktree lifecycle: Host identity is opened
// before Git starts, and the first input later activates that same session.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/ConversationComposer.tsx"),
  "utf8",
);

describe("ConversationComposer worktree setup queue (source contract)", () => {
  it("prepares the real Host session before starting Git", () => {
    expect(source).not.toContain("interceptFirstSend");
    expect(source).toContain("worktreeIntent.beginCreation(trimmed, onPrepareWorktreeSession)");
    expect(source).toContain("preparedSessionIdForSend = begin.sessionId;");
    // The queued send is stashed with its restore callback, not awaited: no pending state during
    // creation, and the draft is claimed at queue time so the composer frees immediately.
    expect(source).toContain("claimSubmittedDraft();");
    expect(source).toContain("restore: restoreSubmittedDraft,");
    expect(source).not.toContain("setPending(true);\n        let interceptResult");
  });

  it("keeps the queued state separate from pending (editor stays editable, only sends are gated)", () => {
    // The queued flag gates canSend and the spinner, but never reports busy to the empty state.
    expect(source).toContain("!worktreeQueued &&");
    expect(source).toContain("pending || worktreeQueued ?");
    expect(source).toContain("submitDisabled={\n            pending || worktreeQueued ||");
    expect(source).toContain("busy: pending,");
    // Duplicate sends while queued are rejected by the ref guard, not by pending.
    expect(source).toContain("pendingWorktreeSendRef.current !== null ||");
  });

  it("dispatches the queued send from an effect when the pipeline turns ready; failure restores the draft", () => {
    expect(source).toContain(
      'worktreePipeline?.status === "ready" &&\n      worktreePipeline.worktreePath &&',
    );
    expect(source).toContain("const queued = pendingWorktreeSendRef.current;");
    expect(source).toContain("void queued.dispatch(");
    expect(source).toContain("queued.preparedSessionId,");
    expect(source).toContain("worktreePipeline?.orphaned");
    // A creation failure puts the claimed message back into the composer for a plain re-send.
    expect(source).toContain("queued.restore();");
  });

  it("clears the visible editor at queue time and restores only when no newer edit exists", () => {
    const claimStart = source.indexOf("const claimSubmittedDraft = (clearEditor = true) => {");
    const claimEnd = source.indexOf("const restoreSubmittedDraft = () => {");
    const claim = source.slice(claimStart, claimEnd);
    expect(claim).toContain("if (clearEditor) {");
    expect(claim).toContain("inputApiRef.current?.clear();");
    expect(claim).toContain('updateText("");');
    expect(claim).toContain("cleanupRevision = contentRevisionRef.current;");
    const restoreStart = source.indexOf("const restoreSubmittedDraft = () => {");
    const restoreEnd = source.indexOf("const finalizeSubmittedDraft = () => {");
    expect(source.slice(restoreStart, restoreEnd)).toContain(
      "contentRevisionRef.current === cleanupRevision",
    );
    const requestedDeliveryBranch = source.slice(
      source.indexOf('requestedDelivery === "startNow"'),
      source.indexOf("const sendResult = await onSendText"),
    );
    expect(requestedDeliveryBranch).toContain("contentRevisionRef.current === cleanupRevision");
  });

  it("withdraws on mode exit or draft departure and restores the queued send once", () => {
    expect(source).toContain("worktreePipeline?.orphaned");
    expect(source).toContain("queued.restore();");
    expect(source).toContain("sessionId === queued.preparedSessionId");
    expect(source).toContain("pendingWorktreeSendRef.current = null;");
  });

  it("uses the ordinary prepared session view while creation is running", () => {
    const sessionPane = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/SessionPane.tsx"),
      "utf8",
    );
    const shell = readFileSync(
      resolve(process.cwd(), "packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
      "utf8",
    );
    expect(shell).not.toContain("provisionalWorktreeChat");
    expect(sessionPane).toContain("onPrepareWorktreeSession={prepareWorktreeSession}");
    // Creation failures persist into the Host-owned preparation record (recovery renders the
    // failure; Retry reuses the same session) instead of staying "preparing" forever.
    expect(sessionPane).toContain("onWorktreePreparationFailed={handleWorktreePreparationFailed}");
    expect(sessionPane).toContain("worktreePreparation: { branchName, targetPath }");
    expect(sessionPane).toContain("preparedSessionId: options.preparedSessionId");
    expect(sessionPane).toContain("<ConversationWorktreeSetupSteps");
    expect(sessionPane).not.toContain("<WorktreeSessionStartingView");
    expect(sessionPane).toContain("contextHeader={isDraft ? draftComposerHeader : undefined}");
    expect(sessionPane).toContain("centered={isDraft}");
    expect(sessionPane).not.toContain("<WorktreePendingPanel");

    const createSessionIndex = sessionPane.indexOf('"createSession"');
    const sendTextIndex = sessionPane.indexOf('"sendText"', createSessionIndex);
    const promoteIndex = sessionPane.indexOf("handleDraftSessionCreated(", sendTextIndex);
    expect(createSessionIndex).toBeGreaterThan(-1);
    expect(sendTextIndex).toBeGreaterThan(createSessionIndex);
    expect(promoteIndex).toBeGreaterThan(sendTextIndex);
    expect(sessionPane).toContain("executionWorktree ? { executionWorktree } : {}");
  });

  it("tracks queued-send admission only on the topic the pane's store owns", () => {
    // The queued dispatch reuses the draft-scoped dispatch closure while targeting the prepared
    // session; marking it pending / expecting its projection on the dropped draft topic produced
    // "accepted input projection silent" noise and futile resync attempts.
    const sessionPane = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/SessionPane.tsx"),
      "utf8",
    );
    expect(sessionPane).toContain("targetSessionId === prewarmBindingRef.current?.sessionId");
    const markPendingIndex = sessionPane.indexOf("lease.store.markCommandPending({");
    const gateIndex = sessionPane.lastIndexOf("&& tracksOnPaneStore", markPendingIndex);
    expect(gateIndex).toBeGreaterThan(-1);
    const expectProjectionIndex = sessionPane.indexOf(
      "lease.store.expectAcceptedInputProjection(envelope.commandId);",
    );
    const projectionGateIndex = sessionPane.lastIndexOf("tracksOnPaneStore", expectProjectionIndex);
    expect(projectionGateIndex).toBeGreaterThan(-1);
  });

  it("never resurrects setup rows from the Host seed after the pipeline settled", () => {
    // Preparation metadata produces no delta, so a live subscriber's seed stays "preparing" after
    // activation; the component must not fall back to it once the local lifecycle settled.
    const steps = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx"),
      "utf8",
    );
    const fallbackStart = steps.indexOf('return preparation.status === "preparing"');
    const settledBranch = steps.indexOf('entry.status === "consumed"', 0);
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(settledBranch).toBeGreaterThan(-1);
    // The settled branch precedes the seed fallback (guard order), and the fallback only runs
    // when there is no entry at all.
    const noEntryGuard = steps.indexOf("if (!entry) {");
    expect(noEntryGuard).toBeGreaterThan(-1);
    expect(noEntryGuard).toBeLessThan(fallbackStart);
    expect(steps.indexOf("return null;", settledBranch)).toBeGreaterThan(settledBranch);
  });

  it("fires telemetry inside the dispatch, after the worktree wait (1:1 send_click/send_result)", () => {
    const runSendIndex = source.indexOf("const runSend = async (");
    const recordSendClickIndex = source.indexOf("conversationTelemetry?.recordSendClick({");
    const localTtftStartIndex = source.indexOf("getLocalTtftObserver()?.start(");
    expect(runSendIndex).toBeGreaterThan(-1);
    // Both telemetry entry points live inside the frozen-send closure, after its declaration.
    expect(recordSendClickIndex).toBeGreaterThan(runSendIndex);
    expect(localTtftStartIndex).toBeGreaterThan(runSendIndex);
    // The queue branch itself performs no user-action or telemetry call before returning.
    const queueBranchIndex = source.indexOf(
      "const begin = await worktreeIntent.beginCreation(trimmed, onPrepareWorktreeSession);",
    );
    const runSendCallIndex = source.indexOf(
      "await runSend(executionWorktree, preparedSessionIdForSend);",
    );
    expect(runSendCallIndex).toBeGreaterThan(queueBranchIndex);
  });

  it("withdraws the queued send on unmount (orphan note; git call finishes)", () => {
    expect(source).toContain(".withdraw(queued.workspaceKey, queued.preparedSessionId)");
  });

  it("consumes the pipeline exactly on a successful worktree send", () => {
    const consumeIndex = source.indexOf("consume(workspaceKey, preparedSessionIdForSend)");
    const successIndex = source.indexOf("if (executionWorktree) {");
    expect(consumeIndex).toBeGreaterThan(successIndex);
    expect(source).not.toContain("onSendAccepted");
  });
});
