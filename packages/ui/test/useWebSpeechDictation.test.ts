// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const mocks = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  desktopEngine: null as Record<string, unknown> | null,
  desktopEnabled: null as boolean | null,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => null,
  useEffectiveShortcutBindings: () => ({ voiceDictation: [] }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The desktop engine's real behavior stays covered by useVoiceDictation.test.ts; here it is a
// recording stub so the tests can prove which engine the control routed the toggle to.
vi.mock("@/hooks/useVoiceDictation.js", () => ({
  useVoiceDictation: (options: { enabled: boolean }) => {
    mocks.desktopEnabled = options.enabled;
    if (!mocks.desktopEngine) throw new Error("desktop engine stub not initialized");
    return mocks.desktopEngine;
  },
}));

import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useWebSpeechDictation } from "@/hooks/useWebSpeechDictation.js";
import { V4ComposerDictationControl } from "@/v4/composer/V4ComposerDictationControl.js";
import { TID_V4_COMPOSER_VOICE_ENTRY } from "@zcode/shared";

interface MockRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

const instances: MockRecognition[] = [];

class MockSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: ((event: Event) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    instances.push(this as unknown as MockRecognition);
  }
}

function currentRecognition(): MockRecognition {
  const recognition = instances.at(-1);
  if (!recognition) throw new Error("no SpeechRecognition instance was created");
  return recognition;
}

/** Builds a result event: entries become SpeechRecognitionResult objects starting at resultIndex. */
function resultEvent(
  entries: Array<{ transcript: string; isFinal: boolean }>,
  resultIndex = 0,
): SpeechRecognitionEvent {
  const results = entries.map((entry) => ({
    isFinal: entry.isFinal,
    length: 1,
    0: { transcript: entry.transcript },
  }));
  return {
    resultIndex,
    results: { length: results.length, ...results },
  } as unknown as SpeechRecognitionEvent;
}

function errorEvent(code: SpeechRecognitionErrorCode): SpeechRecognitionErrorEvent {
  return { error: code } as unknown as SpeechRecognitionErrorEvent;
}

function installWebSpeechApi(): void {
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition = MockSpeechRecognition;
}

function uninstallWebSpeechApi(): void {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  uninstallWebSpeechApi();
  instances.length = 0;
  mocks.settings = null;
  mocks.desktopEngine = null;
  mocks.desktopEnabled = null;
});

beforeEach(() => {
  mocks.desktopEngine = {
    phase: "idle",
    level: 0,
    preview: null,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  };
});

describe("useWebSpeechDictation", () => {
  it("reports unsupported and stays inert when the Web Speech API is missing", () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useWebSpeechDictation({ enabled: true, onTranscript }));

    expect(result.current.supported).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.phase).toBe("idle");
    expect(instances).toHaveLength(0);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("inserts the accumulated final transcript once on stop and mirrors interim text as preview", () => {
    installWebSpeechApi();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useWebSpeechDictation({ enabled: true, onTranscript }));

    act(() => result.current.start());
    const recognition = currentRecognition();
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    // No language setting flows to web: the recognizer keeps the browser default.
    expect(recognition.lang).toBe("");
    expect(result.current.phase).toBe("loading");

    act(() => recognition.onstart?.(new Event("start")));
    expect(result.current.phase).toBe("recording");

    act(() => recognition.onresult?.(resultEvent([{ transcript: "Hello ", isFinal: false }])));
    expect(result.current.preview).toEqual({ committed: "", tentative: "Hello " });

    act(() => recognition.onresult?.(resultEvent([{ transcript: "Hello world.", isFinal: true }])));
    expect(result.current.preview).toEqual({ committed: "Hello world.", tentative: "" });
    expect(onTranscript).not.toHaveBeenCalled();

    act(() => result.current.stop());
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    act(() => recognition.onend?.(new Event("end")));

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("Hello world.");
    expect(result.current.phase).toBe("idle");
    expect(result.current.preview).toBeNull();
  });

  it("passes the configured dictation language through to the recognizer", () => {
    mocks.settings = { voiceDictation: { language: "en" } };
    installWebSpeechApi();
    const { result } = renderHook(() =>
      useWebSpeechDictation({ enabled: true, onTranscript: vi.fn() }),
    );

    act(() => result.current.start());
    expect(currentRecognition().lang).toBe("en");
  });

  it("surfaces permission denial with a toast and returns to idle", () => {
    installWebSpeechApi();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useWebSpeechDictation({ enabled: true, onTranscript }));

    act(() => result.current.start());
    const recognition = currentRecognition();
    act(() => recognition.onstart?.(new Event("start")));
    act(() => recognition.onerror?.(errorEvent("not-allowed")));
    act(() => recognition.onend?.(new Event("end")));

    expect(toast).toHaveBeenCalledWith("voiceDictation.microphoneFailed");
    expect(logger.warn).toHaveBeenCalledWith("web speech dictation error", {
      code: "not-allowed",
    });
    expect(result.current.phase).toBe("idle");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("surfaces recognizer errors as transcription failures", () => {
    installWebSpeechApi();
    const { result } = renderHook(() =>
      useWebSpeechDictation({ enabled: true, onTranscript: vi.fn() }),
    );

    act(() => result.current.start());
    const recognition = currentRecognition();
    act(() => recognition.onstart?.(new Event("start")));
    act(() => recognition.onerror?.(errorEvent("network")));
    act(() => recognition.onend?.(new Event("end")));

    expect(toast).toHaveBeenCalledWith("voiceDictation.transcribeFailed");
    expect(result.current.phase).toBe("idle");
  });

  it("treats a silent session (no-speech) as a normal end without a toast", () => {
    installWebSpeechApi();
    const { result } = renderHook(() =>
      useWebSpeechDictation({ enabled: true, onTranscript: vi.fn() }),
    );

    act(() => result.current.start());
    const recognition = currentRecognition();
    act(() => recognition.onstart?.(new Event("start")));
    act(() => recognition.onerror?.(errorEvent("no-speech")));
    act(() => recognition.onend?.(new Event("end")));

    expect(toast).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("web speech dictation ended early", {
      code: "no-speech",
    });
    expect(result.current.phase).toBe("idle");
  });

  it("ignores repeated start and stop calls", () => {
    installWebSpeechApi();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useWebSpeechDictation({ enabled: true, onTranscript }));

    act(() => result.current.start());
    act(() => result.current.start());
    act(() => result.current.toggle());
    expect(instances).toHaveLength(1);
    expect(currentRecognition().start).toHaveBeenCalledTimes(1);

    const recognition = currentRecognition();
    act(() => recognition.onstart?.(new Event("start")));
    act(() => result.current.stop());
    act(() => result.current.stop());
    act(() => result.current.stop());
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    act(() => recognition.onend?.(new Event("end")));

    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");

    // After the session settled, a new session can start again.
    act(() => result.current.start());
    expect(instances).toHaveLength(2);
  });

  it("aborts on unmount without inserting a pending transcript", () => {
    installWebSpeechApi();
    const onTranscript = vi.fn();
    const { result, unmount } = renderHook(() =>
      useWebSpeechDictation({ enabled: true, onTranscript }),
    );

    act(() => result.current.start());
    const recognition = currentRecognition();
    act(() => recognition.onstart?.(new Event("start")));
    act(() => recognition.onresult?.(resultEvent([{ transcript: "Pending", isFinal: true }])));
    unmount();

    expect(recognition.abort).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe("V4ComposerDictationControl engine gating", () => {
  function renderControl(webRemote: boolean) {
    return render(
      createElement(
        TooltipProvider,
        null,
        createElement(V4ComposerDictationControl, {
          disabled: false,
          onTranscript: vi.fn(),
          scopeRef: { current: null },
          webRemote,
        }),
      ),
    );
  }

  it("hides the mic entry in web remote mode when the API is unavailable", () => {
    renderControl(true);
    expect(screen.queryByTestId(TID_V4_COMPOSER_VOICE_ENTRY)).toBeNull();
  });

  it("routes web remote toggles to the Web Speech engine, not the desktop engine", () => {
    installWebSpeechApi();
    renderControl(true);

    act(() => screen.getByTestId(TID_V4_COMPOSER_VOICE_ENTRY).click());
    expect(instances).toHaveLength(1);
    expect(currentRecognition().start).toHaveBeenCalledTimes(1);
    expect(mocks.desktopEnabled).toBe(false);
    expect(mocks.desktopEngine?.toggle).not.toHaveBeenCalled();
  });

  it("keeps the desktop branch on the desktop engine even when the web API exists", () => {
    installWebSpeechApi();
    renderControl(false);

    act(() => screen.getByTestId(TID_V4_COMPOSER_VOICE_ENTRY).click());
    expect(mocks.desktopEnabled).toBe(true);
    expect(mocks.desktopEngine?.toggle).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(0);
  });
});
