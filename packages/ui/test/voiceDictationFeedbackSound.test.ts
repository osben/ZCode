// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeAudio {
    static instances: FakeAudio[] = [];
    src: string;
    preload = "";
    volume = 1;
    currentTime = 0;
    paused = true;
    playError: Error | null = null;
    private listeners = new Map<string, Set<() => void>>();

    constructor(src: string) {
      this.src = src;
      FakeAudio.instances.push(this);
    }

    addEventListener(event: string, handler: () => void) {
      const set = this.listeners.get(event) ?? new Set<() => void>();
      set.add(handler);
      this.listeners.set(event, set);
    }

    removeEventListener(event: string, handler: () => void) {
      this.listeners.get(event)?.delete(handler);
    }

    pause() {
      this.paused = true;
    }

    play(): Promise<void> {
      this.paused = false;
      if (this.playError) return Promise.reject(this.playError);
      // Simulate playback completing on a later tick so "ended" fires after play() resolves.
      return new Promise((resolve) => {
        setTimeout(() => {
          this.emit("ended");
          resolve();
        }, 0);
      });
    }

    emit(event: string) {
      for (const handler of this.listeners.get(event) ?? []) handler();
    }
  }

  return { FakeAudio };
});

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/logger.js";

const { FakeAudio } = h;
type FakeAudioInstance = InstanceType<typeof FakeAudio>;

const realAudio = globalThis.Audio;

// The module caches its audio elements per kind; reset it so every test starts cold.
async function loadModule() {
  return await import("@/lib/voiceDictationFeedbackSound.js");
}

describe("voice dictation feedback sound", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudio.instances = [];
    (globalThis as { Audio?: unknown }).Audio = FakeAudio as unknown as typeof Audio;
  });

  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = realAudio;
    vi.clearAllMocks();
  });

  it("creates one element per kind pointing at the bundled chimes", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    const start = playVoiceDictationFeedbackSound("start", 70);
    const stop = playVoiceDictationFeedbackSound("stop", 70);
    await Promise.all([start, stop]);

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0]!.src).toContain("voice-dictation-start");
    expect(FakeAudio.instances[1]!.src).toContain("voice-dictation-stop");
  });

  it("applies the clamped volume percent and resolves when playback ends", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    await playVoiceDictationFeedbackSound("start", 54);
    expect(FakeAudio.instances[0]!.volume).toBeCloseTo(0.54);

    await playVoiceDictationFeedbackSound("start", 140);
    expect(FakeAudio.instances[0]!.volume).toBe(1);

    await playVoiceDictationFeedbackSound("start", -5);
    expect(FakeAudio.instances[0]!.volume).toBe(0);
  });

  it("resets a reused element before replaying it", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    await playVoiceDictationFeedbackSound("stop", 50);
    const audio = FakeAudio.instances[0] as FakeAudioInstance;
    // Simulate the element having played to the end.
    audio.currentTime = 0.8;

    await playVoiceDictationFeedbackSound("stop", 50);

    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.paused).toBe(false);
  });

  it("resolves and warns when play() rejects", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    await playVoiceDictationFeedbackSound("start", 70);
    const element = FakeAudio.instances[0] as FakeAudioInstance;
    element.playError = new Error("autoplay policy");

    await expect(playVoiceDictationFeedbackSound("start", 70)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "voice dictation feedback sound failed",
      expect.objectContaining({ kind: "start" }),
    );
  });

  it("resolves through the error event when playback fails mid-sound", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    const pending = playVoiceDictationFeedbackSound("stop", 70);
    const element = FakeAudio.instances[0] as FakeAudioInstance;
    // Play completes on a later tick; fire the element error first.
    element.emit("error");
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves immediately when Audio is unavailable", async () => {
    const { playVoiceDictationFeedbackSound } = await loadModule();
    (globalThis as { Audio?: unknown }).Audio = undefined;
    await expect(playVoiceDictationFeedbackSound("start", 70)).resolves.toBeUndefined();
    expect(FakeAudio.instances).toHaveLength(0);
  });
});
