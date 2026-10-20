import type { IBroadcastService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  buildChangeSummaryDiffViewerSource,
  buildChangeSummaryFilePreviewSource,
  MessageChangeSummaryPanel,
  openChangeSummaryDiffViewer,
} from "@/MessageChangeSummaryPanel.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const mockPlatform = {
  selectDirectory: async () => null,
  selectFile: async () => null,
  onRemoteConnectionLog: () => () => {},
  onRemoteSessionClosed: () => () => {},
  activateOrSetWorkspace: async () => ({ activated: false }),
  connectRemote: async () => ({ success: true }),
  startWebRemoteControl: async () => ({
    status: "running" as const,
    sessionId: "session-1",
    qrUrl: "qr://session-1",
    connectUrl: "https://example.com/connect",
    workspacePath: "/workspace",
  }),
  stopWebRemoteControl: async () => {},
  getWebRemoteControlStatus: async () => ({ status: "idle" as const }),
  disposeRemoteSession: async () => {},
  isDockerAvailable: async () => false,
  listWSLDistros: async () => [],
  listDockerContainers: async () => [],
  listSSHConfigAliases: async () => [],
  openExternal: () => {},
  openFeedback: async () => {},
  openCommunity: async () => {},
  canOpenCommunity: async () => false,
  openInFileManager: async () => ({ success: true }),
  openInEditor: async () => ({ success: true }),
  registerOAuthState: () => {},
  onOAuthCallback: () => () => {},
  notifyRendererReady: () => {},
  showTaskNotification: () => {},
  reportTelemetryEvent: async () => {},
  syncWindowTabs: () => {},
  syncWindowUnreadCount: () => {},
  onFocusTab: () => () => {},
  onNewTab: () => () => {},
  onNewTask: () => () => {},
  onOpenWorkspace: () => () => {},
  onWindowFullscreenChanged: () => () => {},
  onTaskNotificationClick: () => () => {},
  exportLogs: async () => ({ success: true }),
  onUpdateReady: () => () => {},
  onUpdateCheckResult: () => () => {},
  onPostUpdateReleaseNotes: () => () => {},
  acknowledgePostUpdateReleaseNotes: async () => {},
  quitAndInstallUpdate: async () => {},
  getInstalledEditors: async () => [],
  executeDesktopCommand: async () => {},
  setApplicationLocale: async () => {},
  setTitleBarTheme: async () => {},
} as unknown as IPlatformService;

type PanelProps = Parameters<typeof MessageChangeSummaryPanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const defaultProps: PanelProps = {
    summary: {
      fileCount: 1,
      added: 2,
      removed: 1,
      files: [
        {
          path: "/workspace/src/MessageChangeSummaryPanel.tsx",
          added: 2,
          removed: 1,
          writeCount: 1,
          lastTurnIndex: 0,
        },
      ],
    },
    workspacePath: "/workspace",
    changeDetails: {
      turnIndex: 0,
      snapshots: [
        {
          path: "/workspace/src/MessageChangeSummaryPanel.tsx",
          beforeContent: "const next = 1;\nconsole.log(next);\n",
          afterContent: "const next = 2;\nconsole.log(next);\n",
          writeCount: 1,
        },
      ],
    },
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        PlatformProvider,
        { platform: mockPlatform },
        createElement(
          StoreProvider,
          { broadcastService: mockBroadcastService },
          createElement(MessageChangeSummaryPanel, {
            ...defaultProps,
            ...overrides,
          }),
        ),
      ),
    ),
  );
}

describe("MessageChangeSummaryPanel", () => {
  beforeEach(() => {
    localStorageState.clear();
  });

  it("keeps the changed-file list collapsed by default and hides the rewind button first", () => {
    const html = renderPanel();

    expect(html).toContain(expectedCopy("chat.changeSummary.filesChanged.one", { count: 1 }));
    expect(html).toContain("+1");
    expect(html).toContain("-1");
    expect(html).toContain(`aria-label="${expectedCopy("chat.changeSummary.expand")}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain('hidden=""');
    // Bugfix: when the summary is collapsed, file rows stay unmounted so a
    // multi-file change cannot push the latest message out of view.
    expect(html).not.toContain("src/MessageChangeSummaryPanel.tsx");
    expect(html).not.toContain(expectedCopy("chat.changeSummary.openInEditor"));
    expect(html).not.toContain(expectedCopy("appHeader.selectOpenApp"));
  });

  it("prefers the current turn's summary and does not mix in the whole session's totals", () => {
    const html = renderPanel({
      summary: {
        fileCount: 2,
        added: 8,
        removed: 3,
        files: [
          {
            path: "/workspace/src/MessageChangeSummaryPanel.tsx",
            added: 2,
            removed: 1,
            writeCount: 1,
            lastTurnIndex: 1,
          },
          {
            path: "/workspace/src/App.tsx",
            added: 6,
            removed: 2,
            writeCount: 3,
            lastTurnIndex: 0,
          },
        ],
      },
      changeDetails: {
        turnIndex: 1,
        snapshots: [
          {
            path: "/workspace/src/MessageChangeSummaryPanel.tsx",
            beforeContent: "const next = 1;\n",
            afterContent: "const next = 2;\n",
            writeCount: 1,
          },
        ],
      },
    });

    expect(html).toContain(expectedCopy("chat.changeSummary.filesChanged.one", { count: 1 }));
    expect(html).toContain("+1");
    expect(html).not.toContain(expectedCopy("chat.changeSummary.filesChanged.other", { count: 2 }));
    expect(html).not.toContain("src/App.tsx");
    expect(html).not.toContain("+8");
  });

  it("builds a MultiFileDiff code-viewer source for the open button", () => {
    expect(
      buildChangeSummaryDiffViewerSource({
        relativePath: "src/App.tsx",
        snapshot: {
          path: "/workspace/src/App.tsx",
          beforeContent: "const value = 1;\n",
          afterContent: "const value = 2;\n",
          writeCount: 1,
        },
      }),
    ).toEqual({
      type: "multi-file-diff",
      title: "src/App.tsx",
      path: "/workspace/src/App.tsx",
      beforeContent: "const value = 1;\n",
      afterContent: "const value = 2;\n",
    });
  });

  it("builds a plain file preview source for the open button", () => {
    expect(
      buildChangeSummaryFilePreviewSource({
        path: "/workspace/src/App.tsx",
        relativePath: "src/App.tsx",
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:host-a:/workspace",
        workspaceRemoteSessionId: "session-a",
      }),
    ).toEqual({
      type: "file",
      title: "src/App.tsx",
      path: "/workspace/src/App.tsx",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
      workspaceRemoteSessionId: "session-a",
    });
  });

  it("builds a patch preview source for tool-aggregated readonly patches", () => {
    expect(
      buildChangeSummaryDiffViewerSource({
        relativePath: "src/App.tsx",
        path: "/workspace/src/App.tsx",
        snapshot: undefined,
        patch: "--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-old\n+new",
      }),
    ).toEqual({
      type: "patch",
      title: "src/App.tsx",
      path: "/workspace/src/App.tsx",
      patch: "--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-old\n+new",
    });
  });

  it("delegates once when a source and open callback exist, and not when either is missing", () => {
    const source = buildChangeSummaryDiffViewerSource({
      relativePath: "src/App.tsx",
      path: "/workspace/src/App.tsx",
      snapshot: undefined,
      patch: "--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-old\n+new",
    });
    const onOpenCodeViewer = vi.fn();

    expect(openChangeSummaryDiffViewer(source, onOpenCodeViewer)).toBe(true);
    expect(onOpenCodeViewer).toHaveBeenCalledWith(source);

    onOpenCodeViewer.mockClear();
    expect(openChangeSummaryDiffViewer(undefined, onOpenCodeViewer)).toBe(false);
    expect(openChangeSummaryDiffViewer(source, undefined)).toBe(false);
    expect(onOpenCodeViewer).not.toHaveBeenCalled();
  });

  it("shows no rewind entry when a tool-aggregated summary has no real checkpoint", () => {
    const html = renderPanel({
      changeDetails: null,
      onToggleFiles: vi.fn(),
      readonlyDiffPatchesByPath: new Map([
        [
          "/workspace/src/MessageChangeSummaryPanel.tsx",
          "--- a/MessageChangeSummaryPanel.tsx\n+++ b/MessageChangeSummaryPanel.tsx\n@@ -1 +1 @@\n-old\n+new",
        ],
      ]),
    });

    expect(html).toContain(expectedCopy("chat.changeSummary.filesChanged.one", { count: 1 }));
    expect(html).not.toContain(expectedCopy("chat.changeSummary.rewind"));
  });
});
