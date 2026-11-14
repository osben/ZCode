// Owner decision 5 of the upstream 3.18.0 sync: the composer has one mic, fork dictation. The
// upstream voice input (ASR through zcode-server, needs a ZCode account) stays in the codebase but
// is never enabled or rendered in the composer, whether dictation is on or off.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import {
  ComposerWithDraftOwner,
  installMinimalDom,
} from "./v4ConversationComposerLateAckHarness.js";

const state = vi.hoisted(() => ({
  voiceInputEnabled: [] as boolean[],
  voiceButtonRendered: false,
}));

vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({}),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {} }),
}));
vi.mock("@/hooks/useZCodeAgentService.js", () => {
  // The draft owner subscribes to plugin startup events through this service; no-op subscription.
  const agentService = {
    onDynamicPluginStartupDegraded: () => () => ({ dispose: () => {} }),
  };
  return { useZCodeAgentService: () => agentService };
});
vi.mock("@/voice-input/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/voice-input/index.js")>()),
  useComposerVoiceInput: (options: { enabled: boolean }) => {
    state.voiceInputEnabled.push(options.enabled);
    return {
      available: true,
      state: "idle",
      toggle: () => {},
      settle: () => undefined,
      subscribeLevel: () => () => {},
    };
  },
  VoiceInputButton: () => {
    state.voiceButtonRendered = true;
    return null;
  },
}));
vi.mock("@/v4/composer/V4ComposerDictationControl.js", () => ({
  V4ComposerDictationControl: () => null,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/v4/RemoteConversationAvailability.js", () => ({
  useRemoteConversationAvailable: () => true,
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
    ChatPromptEditor: () =>
      React.createElement("form", { "data-testid": "mock-chat-prompt-editor" }),
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

const SESSION_ID = "single-mic-session";
let root: Root;

function render(voiceDictationEnabled: boolean) {
  act(() =>
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ComposerWithDraftOwner, {
          draftMode: false,
          lifecycle: {
            sessionId: SESSION_ID,
            state: "ready",
            generation: 1,
            revision: 1,
            lastError: null,
          },
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
          voiceDictationEnabled,
          workspacePath: "/workspace",
        }),
      ),
    ),
  );
}

beforeEach(() => {
  root = createRoot(installMinimalDom());
  state.voiceInputEnabled = [];
  state.voiceButtonRendered = false;
});

afterEach(() => {
  act(() => root.unmount());
});

describe("composer mic", () => {
  it.each([false, true])(
    "never enables or renders the upstream voice input (dictation on: %s)",
    (voiceDictationEnabled) => {
      render(voiceDictationEnabled);
      expect(state.voiceInputEnabled.length).toBeGreaterThan(0);
      expect(state.voiceInputEnabled.every((enabled) => !enabled)).toBe(true);
      expect(state.voiceButtonRendered).toBe(false);
    },
  );
});
