import { describe, expect, it } from "vitest";
import { isWorktreeProtected } from "@/command-center/worktreeProtection.js";

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
