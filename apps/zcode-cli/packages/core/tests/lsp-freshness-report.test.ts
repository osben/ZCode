import { describe, expect, it } from "vitest";
import { LspError, type LspDiagnostic } from "@zcode/contracts";
import { DiagnosticsFreshness } from "../src/lsp/diagnostics-freshness.js";
import { buildEditReport, EditDiagnosticsTracker } from "../src/lsp/edit-diagnostics.js";
import { toFileUri } from "../src/lsp/uri.js";

const DOC_PATH = "/work/repo/src/a.ts";

function diagnostic(
  partial: Partial<LspDiagnostic> & Pick<LspDiagnostic, "message">,
): LspDiagnostic {
  return {
    path: DOC_PATH,
    line: 1,
    character: 1,
    endLine: 1,
    endCharacter: 2,
    severity: "error",
    ...partial,
  };
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof LspError ? error.code : undefined;
  }
  return undefined;
}

describe("DiagnosticsFreshness rules (spec §5)", () => {
  it("is fresh for the current version after a pull for that version", () => {
    const freshness = new DiagnosticsFreshness<string[]>();
    freshness.recordChange(1);
    expect(freshness.recordPull(1, ["x"])).toBe("fresh");
    expect(freshness.isFreshForCurrent()).toBe(true);
    freshness.recordChange(2);
    expect(freshness.isFreshForCurrent()).toBe(false);
    expect(freshness.lastFresh?.version).toBe(1);
  });

  it("accepts a versioned publish with version >= current and drops an older one", () => {
    const freshness = new DiagnosticsFreshness<string[]>();
    freshness.recordChange(1);
    freshness.recordChange(2);
    expect(freshness.recordPublish({ version: 1, items: ["stale"] })).toBe("stale");
    expect(freshness.isFreshForCurrent()).toBe(false);
    expect(freshness.recordPublish({ version: 2, items: ["fresh"] })).toBe("fresh");
    expect(freshness.currentFresh()?.items).toEqual(["fresh"]);
  });

  it("attributes a versionless publish to the version when exactly one change is in flight", () => {
    const freshness = new DiagnosticsFreshness<string[]>();
    freshness.recordChange(1);
    expect(freshness.recordPublish({ items: ["one"] })).toBe("fresh");
    expect(freshness.currentFresh()).toMatchObject({ version: 1, mode: "attributed" });
  });

  it("does not resolve anything from a versionless publish with two changes in flight", () => {
    const freshness = new DiagnosticsFreshness<string[]>();
    freshness.recordChange(1);
    freshness.recordPublish({ version: 1, items: ["v1"] });
    freshness.recordChange(2);
    freshness.recordChange(3);
    expect(freshness.recordPublish({ items: ["ambiguous"] })).toBe("ambiguous");
    expect(freshness.isFreshForCurrent()).toBe(false);
    // Every publish resets the count, so the next single change is attributable again.
    freshness.recordChange(4);
    expect(freshness.recordPublish({ items: ["after"] })).toBe("fresh");
    expect(freshness.currentFresh()?.version).toBe(4);
  });

  it("keeps the last fresh result as the baseline after a change makes it stale", () => {
    const freshness = new DiagnosticsFreshness<string[]>();
    freshness.recordChange(1);
    freshness.recordPublish({ version: 1, items: ["baseline"] });
    freshness.recordChange(2);
    expect(freshness.currentFresh()).toBeUndefined();
    expect(freshness.lastFresh?.items).toEqual(["baseline"]);
  });
});

describe("buildEditReport", () => {
  it("reports errors first, drops info and hints, and caps the list", () => {
    const warnings = Array.from({ length: 12 }, (_, index) =>
      diagnostic({
        message: `w${index}`,
        severity: "warning",
        line: index + 1,
        endLine: index + 1,
      }),
    );
    const errors = Array.from({ length: 12 }, (_, index) =>
      diagnostic({ message: `e${index}`, line: index + 1, endLine: index + 1 }),
    );
    const info = diagnostic({ message: "info", severity: "info", line: 1, endLine: 1 });
    const report = buildEditReport({
      resolved: [
        {
          entry: entryFor({ changedRange: { startLine: 1, endLine: 30 }, baseline: [] }),
          current: [...warnings, ...errors, info],
        },
      ],
      pendingCount: 0,
      workspacePath: "/work/repo",
      maxItems: 20,
    });
    expect(report.newIssueCount).toBe(24);
    expect(report.errorCount).toBe(12);
    const lines = report.body?.split("\n") ?? [];
    expect(lines[0]).toBe("Found 24 new diagnostic issues in 1 files");
    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines[1]).toContain(" error e0");
    expect(lines[12]).toContain(" error e11");
    expect(lines[13]).toContain(" warning w0");
    expect(lines.at(-1)).toBe("... and 4 more");
    expect(report.body).not.toContain("info");
  });

  it("returns no body when nothing is new and nothing is pending", () => {
    const report = buildEditReport({
      resolved: [],
      pendingCount: 0,
      workspacePath: "/w",
      maxItems: 20,
    });
    expect(report.body).toBeUndefined();
  });

  it("says pending for files that are still not fresh", () => {
    const report = buildEditReport({
      resolved: [],
      pendingCount: 2,
      workspacePath: "/w",
      maxItems: 20,
    });
    expect(report.body).toBe("Diagnostics pending for 2 files");
  });

  it("uses the changed range when no baseline exists and flags noBaseline", () => {
    const report = buildEditReport({
      resolved: [
        {
          entry: entryFor({ changedRange: { startLine: 2, endLine: 2 } }),
          current: [
            diagnostic({ message: "inside", line: 2, endLine: 2 }),
            diagnostic({ message: "outside", line: 8, endLine: 8 }),
          ],
        },
      ],
      pendingCount: 0,
      workspacePath: "/work/repo",
      maxItems: 20,
    });
    expect(report.noBaseline).toBe(true);
    expect(report.body).toContain("inside");
    expect(report.body).not.toContain("outside");
  });
});

describe("EditDiagnosticsTracker", () => {
  it("merges repeated edits of one file and keeps the first decided baseline", () => {
    const tracker = new EditDiagnosticsTracker();
    tracker.recordSyncing({
      path: DOC_PATH,
      uri: toFileUri(DOC_PATH),
      serverId: "s",
      changedRange: { startLine: 2, endLine: 2 },
      at: 1,
    });
    tracker.settle(DOC_PATH, [diagnostic({ message: "base" })]);
    tracker.recordSyncing({
      path: DOC_PATH,
      uri: toFileUri(DOC_PATH),
      serverId: "s",
      changedRange: { startLine: 9, endLine: 9 },
      at: 2,
    });
    tracker.settle(DOC_PATH, undefined);
    const entry = tracker.get(DOC_PATH);
    expect(entry?.changedRange).toEqual({ startLine: 2, endLine: 9 });
    expect(entry?.baseline?.[0]?.message).toBe("base");
    expect(tracker.lastMutation).toBe(2);
  });
});

function entryFor(input: {
  changedRange?: { startLine: number; endLine: number };
  baseline?: LspDiagnostic[];
}) {
  return {
    path: DOC_PATH,
    uri: toFileUri(DOC_PATH),
    serverId: "demo/ts",
    changedRange: input.changedRange,
    syncing: false,
    needsSync: false,
    baselineDecided: true,
    baseline: input.baseline,
    carriedRounds: 0,
    mutatedAt: 0,
  };
}
