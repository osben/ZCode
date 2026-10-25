import { describe, expect, it } from "vitest";
import { deriveVoiceModelStatus } from "@/lib/voiceModelStatus.js";

const state = (
  loadedModelId: string | null,
  activeModelId: string | null = null,
  activePhase: "loading" | "transcribing" | "streaming" | null = null,
) => ({ loadedModelId, activeModelId, activePhase });

describe("deriveVoiceModelStatus", () => {
  it("is none without a selected model", () => {
    expect(deriveVoiceModelStatus(state("a"), null)).toBe("none");
  });

  it("is loading while the selected model loads, even when another one is resident", () => {
    expect(deriveVoiceModelStatus(state(null, "a", "loading"), "a")).toBe("loading");
    expect(deriveVoiceModelStatus(state("b", "a", "loading"), "a")).toBe("loading");
  });

  it("is loaded when the selected model is resident, including while it transcribes or streams", () => {
    expect(deriveVoiceModelStatus(state("a"), "a")).toBe("loaded");
    expect(deriveVoiceModelStatus(state("a", "a", "transcribing"), "a")).toBe("loaded");
    expect(deriveVoiceModelStatus(state("a", "a", "streaming"), "a")).toBe("loaded");
  });

  it("is idle when nothing or only a different model is loaded", () => {
    expect(deriveVoiceModelStatus(state(null), "a")).toBe("idle");
    expect(deriveVoiceModelStatus(state("b"), "a")).toBe("idle");
    expect(deriveVoiceModelStatus(state(null, "b", "loading"), "a")).toBe("idle");
  });
});
