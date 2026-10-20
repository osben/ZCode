// Mounted behavior coverage for ConversationWorktreeSetupSteps (replaces the brittle source
// greps of composerWorktreeQueue.test.ts): setup rows render from the pipeline entry, the Host
// seed only feeds the first paint without an entry, settled entries are never resurrected, and
// an authoritative Host cancellation discards a live entry.
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationWorktreeSetupSteps } from "@/v4/ConversationWorktreeSetupSteps.js";
import { ConversationWorktreeCreatedNotice } from "@/v4/ConversationWorktreeCreatedNotice.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";

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

beforeEach(() => {
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
});

afterEach(() => {
  cleanup();
});

describe("ConversationWorktreeSetupSteps rendering", () => {
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
    expect(screen.getByRole("status").textContent).toContain("feat/session-pr-status");
    expect(screen.getByRole("status").textContent).not.toContain("zcode/quantum-wizard");
    view.unmount();

    renderNotice();
    expect(screen.getByRole("status").textContent).toContain("zcode/quantum-wizard");
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

    expect(screen.getByRole("status").textContent).toContain("Detached HEAD");
    expect(screen.getByRole("status").textContent).not.toContain("zcode/quantum-wizard");
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
    // Retry and Discard actions are both offered for a retryable entry.
    expect(screen.getAllByRole("button")).toHaveLength(2);
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
