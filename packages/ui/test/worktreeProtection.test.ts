import { describe, expect, it } from "vitest";
import {
  isWorktreeProtected,
  isWorktreeRemovalBlockedNow,
} from "@/command-center/worktreeProtection.js";

const base = {
  entry: { path: "/repo/worktrees/feature", branchName: "feature", isCurrent: false },
  canonicalIdentity: "/real/repo/worktrees/feature",
  identitiesResolved: true,
  openPathIdentities: new Set<string>(),
  activePathIdentities: new Set<string>(),
  activeBranchNames: new Set<string>(),
};

describe("isWorktreeProtected", () => {
  it("protects canonical path aliases for open tabs and active sessions", () => {
    expect(
      isWorktreeProtected({
        ...base,
        openPathIdentities: new Set([base.canonicalIdentity]),
      }),
    ).toBe(true);
    expect(
      isWorktreeProtected({
        ...base,
        activePathIdentities: new Set([base.canonicalIdentity]),
      }),
    ).toBe(true);
  });

  it("uses exact branch matching only for active sessions and fails closed while unresolved", () => {
    expect(isWorktreeProtected({ ...base, activeBranchNames: new Set(["feature"]) })).toBe(true);
    expect(isWorktreeProtected({ ...base, activeBranchNames: new Set(["Feature"]) })).toBe(false);
    expect(isWorktreeProtected({ ...base, identitiesResolved: false })).toBe(true);
  });
});

describe("isWorktreeRemovalBlockedNow", () => {
  const target = {
    targetPath: "/repo/worktrees/feature",
    targetBranch: "feature",
    targetIdentity: "/real/repo/worktrees/feature",
    canonicalIdentityOf: (path: string) =>
      path === "/var/repo/worktrees/feature" ? "/real/repo/worktrees/feature" : undefined,
  };

  it("blocks removal of a prepared, not-yet-cancelled session's target worktree (incl. force)", () => {
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [
          {
            worktreePreparation: {
              status: "preparing",
              branchName: "feature",
              targetPath: "/repo/worktrees/feature",
            },
          },
        ],
      }),
    ).toBe(true);
    // Canonical alias of the prepared target still matches.
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [
          {
            worktreePreparation: {
              status: "preparing",
              branchName: "feature",
              targetPath: "/var/repo/worktrees/feature",
            },
          },
        ],
      }),
    ).toBe(true);
    // Branch occupation by a prepared session blocks even at another path.
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [
          {
            worktreePreparation: {
              status: "failed",
              branchName: "feature",
              targetPath: "/elsewhere/feature",
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("releases the guard once the preparation is cancelled", () => {
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [
          {
            worktreePreparation: {
              status: "cancelled",
              branchName: "feature",
              targetPath: "/repo/worktrees/feature",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("blocks for active runtime execution worktrees and allows unrelated ones", () => {
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [{ executionWorktree: { path: "/repo/worktrees/feature", branchName: "feature" } }],
      }),
    ).toBe(true);
    expect(
      isWorktreeRemovalBlockedNow({
        ...target,
        tasks: [{ executionWorktree: { path: "/repo/worktrees/other", branchName: "other" } }],
      }),
    ).toBe(false);
  });
});
