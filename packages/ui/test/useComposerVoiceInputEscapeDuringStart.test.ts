// @vitest-environment jsdom
// Escape while the host is still starting the voice session (the local engine loads its model
// inside start) must not open the microphone afterwards: the attempt is already cancelled.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerVoiceInput } from "@/voice-input/ui/useComposerVoiceInput.js";

const mocks = vi.hoisted(() => {
  let resolveStart: () => void = () => {};
  const voiceInputService = {
    start: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    ),
    cancel: vi.fn(async () => {}),
    sendAudio: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    onEvent: vi.fn(() => ({ dispose: () => {} })),
  };
  return {
    voiceInputService,
    resolveStart: () => resolveStart(),
    startPcmCapture: vi.fn(async () => ({
      stop: vi.fn(async () => ({ peak: 0, durationMs: 0, bytes: 0 })),
      abort: vi.fn(),
    })),
    microphone: {
      ensureAccess: vi.fn(async () => "granted" as const),
      openSettings: vi.fn(),
    },
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ microphone: mocks.microphone }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    voiceInputService: mocks.voiceInputService,
    voiceDictationService: undefined,
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {} }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
vi.mock("@/voice-input/adapters/pcmCapture.js", () => ({
  startPcmCapture: mocks.startPcmCapture,
}));
vi.mock("@/voice-input/ui/useMicrophonePermissionGuide.js", () => ({
  useMicrophonePermissionGuide: () => ({ show: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useComposerVoiceInput", () => {
  it("does not open the microphone when Escape lands while the session is starting", async () => {
    const inputApiRef = {
      current: { beginVoiceText: vi.fn(), endVoiceText: vi.fn(), setVoiceText: vi.fn() },
    } as never;
    const { result } = renderHook(() =>
      useComposerVoiceInput({ inputApiRef, sessionId: "s1", enabled: true }),
    );

    await act(async () => {
      result.current.toggle();
    });
    expect(mocks.voiceInputService.start).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("requesting");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.state).toBe("idle");
    expect(mocks.voiceInputService.cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.resolveStart();
    });
    expect(mocks.startPcmCapture).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});
