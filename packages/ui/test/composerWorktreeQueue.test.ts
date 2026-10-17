// Source-contract coverage for the prepared-session worktree lifecycle wiring. Behavioral
// guarantees (Host reservation before Git, queue-time draft claim, editor clear/restore with
// newer edits, telemetry inside the dispatch, consume-exactly-on-success) live in:
//   packages/ui/test/composerWorktreePipeline.test.ts (runner + store)
//   packages/ui/test/v4ConversationComposerWorktreeLateAck.test.ts (mounted composer)
//   packages/ui/test/conversationWorktreeSetupStepsBehavior.test.ts (mounted setup rows)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/ConversationComposer.tsx"),
  "utf8",
);

describe("ConversationComposer worktree setup queue (source contract)", () => {
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
    expect(sessionPane).toContain("onSyncWorktreePreparation={syncWorktreePreparation}");
    expect(sessionPane).toContain("onSyncPreparation={syncWorktreePreparation}");
    // Creation failures persist into the Host-owned preparation record (recovery renders the
    // failure; Retry reuses the same session) instead of staying "preparing" forever.
    expect(sessionPane).toContain("onWorktreePreparationFailed={handleWorktreePreparationFailed}");
    // The Host reservation payload carries the branch and target (formatting is free to change).
    expect(sessionPane).toContain("worktreePreparation:");
    expect(sessionPane).toContain("branchName,");
    expect(sessionPane).toContain("targetPath,");
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

  it("withdraws the queued send on unmount (orphan note; git call finishes)", () => {
    expect(source).toContain(".withdraw(queued.workspaceKey, queued.preparedSessionId)");
  });
});
