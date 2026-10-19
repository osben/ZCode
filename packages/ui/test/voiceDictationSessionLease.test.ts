import { afterEach, describe, expect, it } from "vitest";
import {
  acquireVoiceDictationSession,
  getVoiceDictationSessionOwner,
  releaseVoiceDictationSession,
} from "@/lib/voiceDictationSessionLease.js";

describe("voice dictation session lease", () => {
  const first = Symbol("first-composer");
  const second = Symbol("second-composer");

  afterEach(() => {
    releaseVoiceDictationSession(first);
    releaseVoiceDictationSession(second);
  });

  it("grants the session to one composer at a time", () => {
    expect(acquireVoiceDictationSession(first)).toBe(true);
    expect(getVoiceDictationSessionOwner()).toBe(first);
    expect(acquireVoiceDictationSession(second)).toBe(false);
    expect(getVoiceDictationSessionOwner()).toBe(first);
  });

  it("lets the owner acquire again without changing ownership", () => {
    expect(acquireVoiceDictationSession(first)).toBe(true);
    expect(acquireVoiceDictationSession(first)).toBe(true);
    expect(getVoiceDictationSessionOwner()).toBe(first);
  });

  it("releases only when the caller is the owner", () => {
    acquireVoiceDictationSession(first);
    releaseVoiceDictationSession(second);
    expect(getVoiceDictationSessionOwner()).toBe(first);
    releaseVoiceDictationSession(first);
    expect(getVoiceDictationSessionOwner()).toBeNull();
    expect(acquireVoiceDictationSession(second)).toBe(true);
  });
});
