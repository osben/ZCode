// @vitest-environment jsdom
// Root Vitest only collects .test.ts; this file uses createElement and needs no TSX extension.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared/test-ids";
import {
  WorkspaceHookPendingBanner,
  workspaceHookPendingDismissStore,
} from "@/v4/WorkspaceHookPendingBanner.js";

// Mock settingsNavigation to verify [Review] also sets the intent
const settingsIntentMock = vi.hoisted(() => ({
  setPendingSettingsSectionIntent: vi.fn(),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: settingsIntentMock.setPendingSettingsSectionIntent,
}));

// Mock TabStoreProvider's openSettingsTab
const openSettingsTabMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: () => openSettingsTabMock,
}));

// Mock workspaceHookReviewStore's findWorkspaceHookCommandBinding
const sendCommandMock = vi.hoisted(() => vi.fn(async () => ({ status: "accepted" })));
const onCommandSettledMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/workspaceHookReviewStore.js", () => ({
  useWorkspaceHookReviewStore: () => ({
    commandBindings: {
      "sess-1": {
        sessionId: "sess-1",
        workspacePath: "/workspace",
        workspaceIdentity: "/workspace",
        sendCommand: sendCommandMock,
        onCommandSettled: onCommandSettledMock,
      },
    },
  }),
  findWorkspaceHookCommandBinding: (
    _bindings: unknown,
    _workspacePath?: string | null,
    _workspaceIdentity?: string,
  ) => ({
    sessionId: "sess-1",
    workspacePath: "/workspace",
    workspaceIdentity: "/workspace",
    sendCommand: sendCommandMock,
    onCommandSettled: onCommandSettledMock,
  }),
}));

// Mock V4ConversationContext's sendCommand
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    sendCommand: sendCommandMock,
  }),
}));

// Mock workspaceHookReviewCommands' sendWorkspaceHookCommand
const sendWorkspaceHookCommandMock = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));

vi.mock("@/settings/workspaceHookReviewCommands.js", () => ({
  sendWorkspaceHookCommand: sendWorkspaceHookCommandMock,
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMock.warn,
    error: vi.fn(),
  },
}));

const sampleAdmission = {
  pendingCount: 2,
  bundleDigest: "a".repeat(64),
  workspaceIdentity: "/workspace",
};

function renderBanner(props: {
  sessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  admission?: { pendingCount: number; bundleDigest: string; workspaceIdentity?: string } | null;
  onReview?: () => void;
  onDismiss?: () => void;
}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkspaceHookPendingBanner, {
        sessionId: props.sessionId ?? "sess-1",
        workspacePath: props.workspacePath ?? "/workspace",
        workspaceIdentity: props.workspaceIdentity,
        admission: "admission" in props ? props.admission : sampleAdmission,
        onReview: props.onReview,
        onDismiss: props.onDismiss,
      }),
    ),
  );
}

function renderInteractiveBanner(admission = sampleAdmission) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkspaceHookPendingBanner, {
        sessionId: "sess-1",
        workspacePath: "/workspace",
        admission,
      }),
    ),
  );
}

describe("WorkspaceHookPendingBanner (soft gate D4)", () => {
  beforeEach(() => {
    workspaceHookPendingDismissStore.clear();
    settingsIntentMock.setPendingSettingsSectionIntent.mockClear();
    openSettingsTabMock.mockClear();
    sendWorkspaceHookCommandMock.mockClear();
    sendCommandMock.mockClear();
    onCommandSettledMock.mockClear();
    loggerMock.warn.mockClear();
  });

  afterEach(() => cleanup());

  it("renders the banner when pendingCount > 0", () => {
    const html = renderBanner({ admission: sampleAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
    expect(html).toContain("2");
  });

  it("does not render when pendingCount === 0", () => {
    const html = renderBanner({
      admission: { pendingCount: 0, bundleDigest: "b".repeat(64) },
    });
    expect(html).not.toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
  });

  it("does not render when admission is null", () => {
    const html = renderBanner({ admission: null });
    expect(html).not.toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
  });

  it("a bundle change invalidates the dismissal and the banner reappears", () => {
    // Dismiss the old bundle
    workspaceHookPendingDismissStore.dismiss("sess-1", sampleAdmission.bundleDigest);
    const newAdmission = {
      pendingCount: 3,
      bundleDigest: "c".repeat(64),
      workspaceIdentity: "/workspace",
    };
    const html = renderBanner({ admission: newAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
    expect(html).toContain("3");
  });

  it("hides immediately after clicking dismiss and reappears when bundleDigest changes", () => {
    const view = renderInteractiveBanner();
    expect(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_DISMISS));
    expect(screen.queryByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeNull();

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkspaceHookPendingBanner, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          admission: { ...sampleAdmission, bundleDigest: "c".repeat(64) },
        }),
      ),
    );
    expect(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeTruthy();
  });

  it("logs a warn through the UI logger when requestWorkspaceHookReview rejects", async () => {
    sendWorkspaceHookCommandMock.mockRejectedValueOnce(new Error("request rejected"));
    renderInteractiveBanner();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_REVIEW));

    await waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[workspace-hook-pending] requestWorkspaceHookReview 发送失败",
        expect.objectContaining({
          bundleDigest: sampleAdmission.bundleDigest,
          sessionId: "sess-1",
        }),
      );
    });
  });

  it("has both a [Review] button and a [Dismiss] button", () => {
    const html = renderBanner({ admission: sampleAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_REVIEW + '"');
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_DISMISS + '"');
  });
});
