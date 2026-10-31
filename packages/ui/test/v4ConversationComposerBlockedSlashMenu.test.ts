// Upstream 3.17.1 keeps the recovery command (/reload) in the composer slash menu while the runtime
// is blocked; the merge had kept the older "blocked hides everything" rule. This suite mounts the
// real ConversationComposer and checks the commands it hands to the prompt editor's slash menu.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLifecycleSnapshot } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import {
  ComposerWithDraftOwner,
  installMinimalDom,
} from "./v4ConversationComposerLateAckHarness.js";

const state = vi.hoisted(() => ({
  remoteAvailable: true,
  editorAppSlashCommands: undefined as AppSlashCommand[] | undefined,
}));

vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({}),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {} }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/v4/RemoteConversationAvailability.js", () => ({
  useRemoteConversationAvailable: () => state.remoteAvailable,
}));
vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});
vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      state.editorAppSlashCommands = props.appSlashCommands as AppSlashCommand[] | undefined;
      return React.createElement("form", { "data-testid": "mock-chat-prompt-editor" });
    },
  };
});
vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    attachmentInputRef: { current: null },
    attachments: [],
    clearAttachments: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    removeAttachment: vi.fn(),
    restoreDraftAttachments: vi.fn(),
    restoreSessionOwnedAttachments: vi.fn(),
    retryAttachment: vi.fn(),
    setAttachmentError: vi.fn(),
  }),
}));
vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span", null, "mode"),
    V4ComposerModelControls: () => React.createElement("span", null, "model"),
  };
});

const SESSION_ID = "blocked-slash-session";
const commands: AppSlashCommand[] = [
  { value: "side", description: "side", run: vi.fn() },
  { value: "reload", description: "reload", recovery: true, run: vi.fn() },
];
let root: Root;

function lifecycle(lifecycleState: SessionLifecycleSnapshot["state"]): SessionLifecycleSnapshot {
  return {
    sessionId: SESSION_ID,
    state: lifecycleState,
    generation: 1,
    revision: 1,
    lastError: null,
  };
}

function render(lifecycleState: SessionLifecycleSnapshot["state"]) {
  act(() =>
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ComposerWithDraftOwner, {
          appSlashCommands: commands,
          draftMode: false,
          lifecycle: lifecycle(lifecycleState),
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText: vi.fn(async () => {}),
          submissionReady: true,
          modelSelectionView: null,
          modelSelectionSettled: false,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId: SESSION_ID,
          snapshot: null,
          workspacePath: "/workspace",
        }),
      ),
    ),
  );
}

const offered = () => state.editorAppSlashCommands?.map((command) => command.value);

beforeEach(() => {
  root = createRoot(installMinimalDom());
  state.remoteAvailable = true;
  state.editorAppSlashCommands = undefined;
});

afterEach(() => {
  act(() => root.unmount());
});

describe("composer slash menu while the runtime is blocked", () => {
  it("offers every app command while the runtime is ready", () => {
    render("ready");
    expect(offered()).toEqual(["side", "reload"]);
  });

  it("offers only the recovery command when the runtime is faulted and recovery is available", () => {
    render("faulted");
    expect(offered()).toEqual(["reload"]);
  });

  it("offers no app command when the runtime is faulted and recovery is unavailable", () => {
    state.remoteAvailable = false;
    render("faulted");
    expect(offered()).toEqual([]);
  });
});
