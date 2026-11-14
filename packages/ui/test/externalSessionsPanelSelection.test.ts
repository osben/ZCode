import { describe, expect, it } from "vitest";
import type {
  ExternalSessionSource,
  ExternalSessionSourceStatus,
} from "../src/external-sessions/contract.js";
import {
  isChipUnavailable,
  selectedSourceStatuses,
  showChipCount,
  summarizeSourceSelection,
  toggleSourceSelection,
} from "../src/external-sessions/panelViewState.js";

// specs/external-sessions.md "UI": selection-scoped counts, empty-state message and chip styling.

const scanned = (count: number): ExternalSessionSourceStatus => ({ available: true, count });
const unavailable = (reason: string): ExternalSessionSourceStatus => ({
  available: false,
  count: 0,
  reason,
});
const notScanned = unavailable("not scanned");

describe("external sessions panel selection", () => {
  it("persisted ['claude'] with Claude scanned empty and the rest never scanned shows the empty message, not the unreadable-store message", () => {
    const statuses = {
      claude: scanned(0),
      codex: notScanned,
      cursor: notScanned,
      gemini: notScanned,
      opencode: notScanned,
    };
    const summary = summarizeSourceSelection(statuses, ["claude"]);
    expect(summary.totalCount).toBe(0);
    expect(summary.everySourceUnavailable).toBe(false);
  });

  it("a selected source that really failed is what makes every selected source unavailable", () => {
    const statuses = { claude: unavailable("permission denied"), codex: scanned(3) };
    expect(summarizeSourceSelection(statuses, ["claude"]).everySourceUnavailable).toBe(true);
    expect(summarizeSourceSelection(statuses, ["claude", "codex"]).everySourceUnavailable).toBe(
      false,
    );
  });

  it("counts only the selected sources, so a deselected cached count is excluded from the total", () => {
    const statuses = { claude: scanned(2), codex: scanned(5) };
    expect(summarizeSourceSelection(statuses, ["claude"]).totalCount).toBe(2);
    expect(summarizeSourceSelection(statuses, []).totalCount).toBe(7);
    expect(selectedSourceStatuses(statuses, ["claude"])).toEqual([scanned(2)]);
  });

  it("an absent status map yields no selected statuses and no empty-unavailable state", () => {
    expect(selectedSourceStatuses(undefined, [])).toEqual([]);
    expect(summarizeSourceSelection(undefined, []).everySourceUnavailable).toBe(false);
  });

  it("a deselected chip is never styled unavailable, even when its cached status is unavailable", () => {
    const statuses = { claude: scanned(1), codex: unavailable("no store") };
    expect(isChipUnavailable(statuses, ["claude"], "codex")).toBe(false);
    expect(isChipUnavailable(statuses, ["codex"], "codex")).toBe(true);
    expect(isChipUnavailable(statuses, [], "codex")).toBe(true);
    expect(isChipUnavailable(statuses, ["codex"], "claude")).toBe(false);
  });

  it("shows a chip count only for an active chip or an available source", () => {
    const statuses: Partial<Record<ExternalSessionSource, ExternalSessionSourceStatus>> = {
      claude: scanned(4),
      codex: unavailable("no store"),
    };
    // Active: shown, even when unavailable (count 0).
    expect(showChipCount(statuses, ["codex"], "codex")).toBe(true);
    // Deselected and available (cached from an earlier scan): shown.
    expect(showChipCount(statuses, ["codex"], "claude")).toBe(true);
    // Deselected and unavailable: hidden.
    expect(showChipCount(statuses, ["claude"], "codex")).toBe(false);
    // No status at all (never scanned): hidden.
    expect(showChipCount(statuses, ["claude"], "gemini")).toBe(false);
  });

  it("toggling a chip from the every-source sentinel turns off only that chip", () => {
    const next = toggleSourceSelection([], "codex");
    expect(new Set(next)).toEqual(new Set(["claude", "cursor", "gemini", "opencode"]));
    expect(next).not.toEqual([]);
  });

  it("re-adding the fifth source returns the selection to the every-source sentinel", () => {
    expect(toggleSourceSelection(["claude", "cursor", "gemini", "opencode"], "codex")).toEqual([]);
  });

  it("adding a source to a partial selection keeps the other selected sources", () => {
    expect(toggleSourceSelection(["claude"], "gemini")).toEqual(["claude", "gemini"]);
  });

  it("turning off the last remaining chip is a no-op, not a return to every source", () => {
    const current: ExternalSessionSource[] = ["claude"];
    expect(toggleSourceSelection(current, "claude")).toEqual(["claude"]);
  });

  it("turning off one of two selected chips leaves the other selected", () => {
    expect(toggleSourceSelection(["claude", "codex"], "claude")).toEqual(["codex"]);
  });
});
