// Mounted behavior coverage for ConversationWorktreeSetupSteps (replaces the brittle source
// greps of composerWorktreeQueue.test.ts): setup rows render from the pipeline entry, the Host
// seed only feeds the first paint without an entry, settled entries are never resurrected, and
// an authoritative Host cancellation discards a live entry.
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationWorktreeSetupSteps } from "@/v4/ConversationWorktreeSetupSteps.js";
import { ConversationWorktreeCreatedNotice } from "@/v4/ConversationWorktreeCreatedNotice.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";

// Whether a Git runner for the session is in flight in this renderer (a live creation).
const pipelineRunner = vi.hoisted(() => ({ inFlight: false }));
vi.mock("@/v4/composer/composerWorktreePipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/composer/composerWorktreePipeline.js")>()),
  isComposerWorktreePipelineInFlight: () => pipelineRunner.inFlight,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    rpcReady: false,
    services: { gitService: { listWorktrees: vi.fn() } },
  }),
}));

const WORKSPACE_KEY = "/dev/setup-steps";
const PARAMS = {
  workspacePath: WORKSPACE_KEY,
  branchName: "zcode/sleepy-capybara",
  targetPath: "/dev/setup-worktrees/zcode-sleepy-capybara",
  baseBranch: "main",
  baseFromHeadDefault: false,
};

function renderSteps(
  preparation: {
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
    attemptId?: string;
  },
  sessionId = "session-prepared-1",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationWorktreeSetupSteps, {
        workspacePath: WORKSPACE_KEY,
        sessionId,
        preparation: {
          branchName: PARAMS.branchName,
          targetPath: PARAMS.targetPath,
          baseBranch: PARAMS.baseBranch,
          ...preparation,
        },
        onRetryPreparation: vi.fn(async () => undefined),
        onCancelPreparation: vi.fn(async () => undefined),
        onPreparationFailed: vi.fn(async () => undefined),
      }),
    ),
  );
}

/**
 * The pane mounts the setup card without a Host marker when the session's snapshot carries none
 * (ISSUE-051): the card must then render from the renderer's own pipeline entry.
 */
function renderEntryOnlySteps(sessionId = "session-prepared-1") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationWorktreeSetupSteps, {
        workspacePath: WORKSPACE_KEY,
        sessionId,
        onRetryPreparation: vi.fn(async () => undefined),
        onCancelPreparation: vi.fn(async () => undefined),
        onPreparationFailed: vi.fn(async () => undefined),
      }),
    ),
  );
}

beforeEach(() => {
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  pipelineRunner.inFlight = false;
});

afterEach(() => {
  cleanup();
});

describe("ConversationWorktreeSetupSteps rendering", () => {
  it.each(["creating", "failed"] as const)(
    "does not duplicate the queued submission inside the %s card (the timeline slot owns message order)",
    (status) => {
      const submittedText = Array.from(
        { length: 12 },
        (_, index) => `Message line ${index + 1}`,
      ).join("\n");
      useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
        status,
        sessionId: "session-prepared-1",
        params: { ...PARAMS, attemptId: "attempt-message-order" },
        queuedPromptPreview: submittedText,
        ...(status === "failed" ? { failureMessage: "git interrupted" } : {}),
        createdAt: 1,
      });
      renderSteps({
        status: status === "failed" ? "failed" : "preparing",
        attemptId: "attempt-message-order",
      });

      // The card renders only the worktree line; the frozen preview and the authoritative user
      // row above it own the message content (specs/composer-worktree-setup-steps.md).
      expect(document.querySelector("[data-worktree-setup-queued-message]")).toBeNull();
      expect(document.querySelector(`[data-worktree-setup-step='${status}']`)).not.toBeNull();
    },
  );

  it("shows the current Git branch in the created notice and falls back while Git loads", () => {
    const renderNotice = (currentBranchName?: string | null) =>
      render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(ConversationWorktreeCreatedNotice, {
            branchName: "zcode/quantum-wizard",
            ...(currentBranchName !== undefined ? { currentBranchName } : {}),
            path: "/repo/worktrees/zcode-quantum-wizard",
          }),
        ),
      );

    const view = renderNotice("feat/session-pr-status");
    const summaryOf = () => document.querySelector("[data-worktree-created-summary]");
    expect(summaryOf()?.textContent).toContain("feat/session-pr-status");
    expect(summaryOf()?.textContent).not.toContain("zcode/quantum-wizard");
    view.unmount();

    renderNotice();
    expect(summaryOf()?.textContent).toContain("zcode/quantum-wizard");
  });

  it("shows Detached HEAD instead of the creation-time branch when the worktree is detached", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationWorktreeCreatedNotice, {
          branchName: "zcode/quantum-wizard",
          currentBranchName: "Detached HEAD",
          path: "/repo/worktrees/zcode-quantum-wizard",
        }),
      ),
    );

    const summary = document.querySelector("[data-worktree-created-summary]");
    expect(summary?.textContent).toContain("Detached HEAD");
    expect(summary?.textContent).not.toContain("zcode/quantum-wizard");
  });

  it("expands the created notice to the worktree path and the executed command", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationWorktreeCreatedNotice, {
          branchName: "zcode/quantum-wizard",
          path: "/repo/worktrees/zcode-quantum-wizard",
        }),
      ),
    );

    // Collapsed by default: one compact trigger line, details hidden.
    expect(document.querySelector("[data-worktree-created] [data-state='open']")).toBeNull();
    // `Worktree · <branch>`: the summary is the branch alone, without a "created" word.
    expect(document.querySelector("[data-worktree-created-summary]")?.textContent).toBe(
      "zcode/quantum-wizard",
    );

    fireEvent.click(document.querySelector("[data-worktree-created] button")!);
    expect(document.querySelector("[data-worktree-created-command]")?.textContent).toBe(
      "git worktree add -b zcode/quantum-wizard -- /repo/worktrees/zcode-quantum-wizard",
    );
  });

  it("shows the creating row from the Host seed on first paint and materializes the entry", () => {
    renderSteps({ status: "preparing", attemptId: "attempt-1" });
    const card = document.querySelector("[data-worktree-setup-steps]");
    expect(card).not.toBeNull();
    expect(document.querySelector("[data-worktree-setup-step='creating']")).not.toBeNull();
    const entry = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_KEY,
      "session-prepared-1",
    );
    expect(entry).toMatchObject({ status: "creating", sessionId: "session-prepared-1" });
  });

  it("renders the failure row with Retry from a failed entry", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "failed",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-1" },
      failureMessage: "git interrupted",
      createdAt: 1,
    });
    renderSteps({ status: "failed", attemptId: "attempt-1", failureMessage: "git interrupted" });
    expect(document.querySelector("[data-worktree-setup-step='failed']")).not.toBeNull();
    // Retry and Discard actions are both offered for a retryable entry (the collapsible
    // summary trigger is an additional button).
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  });

  it("renders the failed card from the pipeline entry alone when the snapshot carries no marker (ISSUE-051)", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "failed",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-entry-only" },
      failureMessage: "could not create leading directories: Permission denied",
      createdAt: 1,
    });
    const firstVisit = renderEntryOnlySteps();
    expect(document.querySelector("[data-worktree-setup-step='failed']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    firstVisit.unmount();

    // Returning to the session (fresh mount, still no Host marker) resumes the same failure
    // state with its Retry action instead of stranding the frozen submission.
    renderEntryOnlySteps();
    expect(document.querySelector("[data-worktree-setup-step='failed']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the orphan note on a failed card after withdrawing during creation (ISSUE-051 entry-only path)", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-orphaned" },
      createdAt: 1,
    });
    // The honest orphan sequence: the user unchecks Worktree while Git is in flight (withdraw),
    // the runner is not cancellable, and its failure lands on the same orphaned entry.
    useComposerWorktreePipelineStore.getState().withdraw(WORKSPACE_KEY, "session-prepared-1");
    useComposerWorktreePipelineStore
      .getState()
      .markFailed(WORKSPACE_KEY, "git interrupted", "session-prepared-1", "attempt-orphaned");
    renderEntryOnlySteps();
    expect(document.querySelector("[data-worktree-setup-step='failed']")).not.toBeNull();
    // A failure auto-expands the card, so the orphan note text is in the DOM without clicking.
    expect(
      screen.getByText("This setup no longer belongs to an active session and can be discarded."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("collapses ready details behind the summary line and expands on click (reasoning-style)", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "ready",
      sessionId: "session-prepared-1",
      worktreePath: "/dev/setup-worktrees/zcode-sleepy-capybara",
      params: { ...PARAMS, attemptId: "attempt-1" },
      createdAt: 1,
    });
    renderSteps({ status: "preparing", attemptId: "attempt-1" });

    // The ready summary names the branch while the path detail and command stay hidden until
    // expanded.
    const summary = document.querySelector("[data-worktree-setup-step='ready']");
    expect(summary?.textContent).toContain("zcode/sleepy-capybara");
    expect(
      document.querySelector("[data-worktree-setup-collapsible] [data-state='open']"),
    ).toBeNull();

    fireEvent.click(document.querySelector("[data-worktree-setup-collapsible] button")!);
    expect(
      screen.getByText("Worktree ready: /dev/setup-worktrees/zcode-sleepy-capybara"),
    ).toBeTruthy();
    expect(document.querySelector("[data-worktree-setup-command]")?.textContent).toBe(
      "git worktree add -b zcode/sleepy-capybara -- /dev/setup-worktrees/zcode-sleepy-capybara main",
    );
  });

  it("shows the base branch in the creation command and the HEAD default as literal HEAD", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "ready",
      sessionId: "session-prepared-1",
      worktreePath: "/dev/setup-worktrees/zcode-sleepy-capybara",
      params: {
        ...PARAMS,
        attemptId: "attempt-1",
        baseBranch: "release/1.2",
      },
      createdAt: 1,
    });
    const withBase = renderSteps({ status: "preparing", attemptId: "attempt-1" });
    fireEvent.click(document.querySelector("[data-worktree-setup-collapsible] button")!);
    expect(document.querySelector("[data-worktree-setup-command]")?.textContent).toBe(
      "git worktree add -b zcode/sleepy-capybara -- /dev/setup-worktrees/zcode-sleepy-capybara release/1.2",
    );
    withBase.unmount();

    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "ready",
      sessionId: "session-prepared-1",
      worktreePath: "/dev/setup-worktrees/zcode-sleepy-capybara",
      params: {
        ...PARAMS,
        attemptId: "attempt-2",
        baseBranch: undefined,
        baseFromHeadDefault: true,
      },
      createdAt: 1,
    });
    renderSteps({ status: "preparing", attemptId: "attempt-2" });
    fireEvent.click(document.querySelector("[data-worktree-setup-collapsible] button")!);
    expect(document.querySelector("[data-worktree-setup-command]")?.textContent).toBe(
      "git worktree add -b zcode/sleepy-capybara -- /dev/setup-worktrees/zcode-sleepy-capybara HEAD",
    );
  });

  it("keeps a restored preparation collapsed from the first frame through ready", () => {
    // Opening a session whose preparation was never activated: empty renderer store, Host seed
    // `preparing`, no local Git runner. The reconcile later settles the restored entry to ready.
    const openStates: boolean[] = [];
    const recordOpen = () =>
      openStates.push(
        document.querySelector("[data-worktree-setup-collapsible] [data-state='open']") !== null,
      );
    const unsubscribe = useComposerWorktreePipelineStore.subscribe(recordOpen);

    renderSteps({ status: "preparing", attemptId: "attempt-restored" });
    recordOpen();
    expect(document.querySelector("[data-worktree-setup-step='creating']")).not.toBeNull();

    act(() => {
      useComposerWorktreePipelineStore
        .getState()
        .markReady(
          WORKSPACE_KEY,
          PARAMS.targetPath,
          true,
          "session-prepared-1",
          "attempt-restored",
        );
    });
    recordOpen();
    unsubscribe();

    expect(document.querySelector("[data-worktree-setup-step='ready']")).not.toBeNull();
    expect(openStates.length).toBeGreaterThan(1);
    expect(openStates.every((open) => !open)).toBe(true);
  });

  it("auto-opens the details while creating and after a failure", () => {
    // A live creation: this renderer's Git runner is in flight for the session.
    pipelineRunner.inFlight = true;
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-1" },
      createdAt: 1,
    });
    const creating = renderSteps({ status: "preparing", attemptId: "attempt-1" });
    expect(
      document.querySelector("[data-worktree-setup-collapsible] [data-state='open']"),
    ).not.toBeNull();
    creating.unmount();

    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "failed",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-1" },
      failureMessage: "git interrupted",
      createdAt: 1,
    });
    renderSteps({ status: "failed", attemptId: "attempt-1", failureMessage: "git interrupted" });
    expect(
      document.querySelector("[data-worktree-setup-collapsible] [data-state='open']"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("never resurrects setup rows after the pipeline settled, even from a stale preparing seed", () => {
    for (const terminal of ["consumed", "discarded"] as const) {
      useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
      useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
        status: terminal,
        sessionId: "session-prepared-1",
        params: { ...PARAMS, attemptId: "attempt-1" },
        createdAt: 1,
      });
      renderSteps({ status: "preparing", attemptId: "attempt-1" });
      expect(document.querySelector("[data-worktree-setup-steps]")).toBeNull();
    }
  });

  it("discards a live entry when the Host reports the preparation cancelled", () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-1" },
      createdAt: 1,
    });
    renderSteps({ status: "cancelled", attemptId: "attempt-1" });
    expect(document.querySelector("[data-worktree-setup-steps]")).toBeNull();
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        WORKSPACE_KEY,
        "session-prepared-1",
      )?.status,
    ).toBe("discarded");
  });
});
