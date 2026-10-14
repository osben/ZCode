// @vitest-environment jsdom
//
// Branch-name generator (2026-10-13 spec): deterministic under an injected RNG, retry avoids
// taken (composed) names, and the dictionary stays lowercase ASCII git-safe. The name format
// is fixed — there is no user-facing template (review 2026-10-13).

import { describe, expect, it } from "vitest";
import {
  generateWorktreeBranchName,
  generateWorktreeBranchNameCandidate,
} from "@/command-center/worktreeNameGenerator.js";

/** Deterministic LCG so every draw sequence is reproducible in assertions. */
function createSequenceRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe("generateWorktreeBranchNameCandidate", () => {
  it("produces <adjective>-<noun> names", () => {
    expect(generateWorktreeBranchNameCandidate(createSequenceRandom(1))).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("produces lowercase ASCII branch-safe names over many draws", () => {
    const random = createSequenceRandom(5);
    for (let index = 0; index < 200; index += 1) {
      const name = generateWorktreeBranchNameCandidate(random);
      expect(name).toMatch(/^[a-z][a-z-]*$/);
      expect(name).not.toContain("..");
      expect(name.endsWith("-")).toBe(false);
    }
  });

  it("is deterministic for a given RNG sequence", () => {
    expect(generateWorktreeBranchNameCandidate(createSequenceRandom(7))).toBe(
      generateWorktreeBranchNameCandidate(createSequenceRandom(7)),
    );
  });
});

describe("generateWorktreeBranchName", () => {
  it("returns the first candidate when nothing is taken", () => {
    const name = generateWorktreeBranchName({
      isTaken: () => false,
      random: createSequenceRandom(7),
    });
    expect(name).toBe(generateWorktreeBranchNameCandidate(createSequenceRandom(7)));
  });

  it("avoids taken composed names by retrying", () => {
    const random = createSequenceRandom(8);
    const candidates = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      candidates.add(generateWorktreeBranchNameCandidate(random));
    }
    const name = generateWorktreeBranchName({
      isTaken: (candidate) => candidate !== [...candidates][4],
      random: createSequenceRandom(8),
      maxAttempts: 10,
    });
    expect(name).toBe([...candidates][4]);
  });

  it("returns the candidate as-is when every attempt is taken", () => {
    const random = createSequenceRandom(6);
    const last = (() => {
      let candidate = "";
      for (let index = 0; index < 3; index += 1) {
        candidate = generateWorktreeBranchNameCandidate(random);
      }
      return candidate;
    })();
    const name = generateWorktreeBranchName({
      isTaken: () => true,
      random: createSequenceRandom(6),
      maxAttempts: 3,
    });
    expect(name).toBe(last);
  });
});
