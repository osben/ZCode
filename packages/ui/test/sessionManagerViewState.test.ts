import { describe, expect, it } from "vitest";
import { SESSION_MANAGER_VIEW_STORAGE_KEY } from "@/session-manager/sessionManagerViewState.js";
import {
  hasActiveSessionManagerFilters,
  parseSessionManagerViewState,
  SESSION_MANAGER_DEFAULT_VIEW_STATE,
} from "@/session-manager/sessionManagerViewState.js";

describe("parseSessionManagerViewState", () => {
  it("returns defaults for null and malformed payloads", () => {
    expect(parseSessionManagerViewState(null)).toEqual(SESSION_MANAGER_DEFAULT_VIEW_STATE);
    expect(parseSessionManagerViewState("not json")).toEqual(SESSION_MANAGER_DEFAULT_VIEW_STATE);
    expect(parseSessionManagerViewState('"string"')).toEqual(SESSION_MANAGER_DEFAULT_VIEW_STATE);
  });

  it("round-trips a full valid payload", () => {
    const payload = JSON.stringify({
      status: "archived",
      environment: "worktree",
      type: "cron",
      pinnedOnly: true,
      sortColumn: "created",
      sortDirection: "asc",
      columns: ["name", "updated"],
      collapsedGroups: ["/dev/a", "/dev/b"],
    });
    const parsed = parseSessionManagerViewState(payload);
    expect(parsed.status).toBe("archived");
    expect(parsed.environment).toBe("worktree");
    expect(parsed.type).toBe("cron");
    expect(parsed.pinnedOnly).toBe(true);
    expect(parsed.sortColumn).toBe("created");
    expect(parsed.sortDirection).toBe("asc");
    expect(parsed.columns).toEqual(["name", "updated"]);
    expect(parsed.collapsedGroups).toEqual(["/dev/a", "/dev/b"]);
  });

  it("drops unknown fields and falls back on invalid values", () => {
    const parsed = parseSessionManagerViewState(
      JSON.stringify({
        status: "bogus",
        environment: 7,
        type: "all",
        pinnedOnly: "yes",
        sortColumn: "name",
        unknownFutureField: { nested: true },
        collapsedGroups: ["/dev/a", 42, null],
      }),
    );
    expect(parsed.status).toBe("active");
    expect(parsed.environment).toBe("all");
    expect(parsed.pinnedOnly).toBe(false);
    expect(parsed.collapsedGroups).toEqual(["/dev/a"]);
    // Unknown keys never reach the persisted shape.
    expect("unknownFutureField" in parsed).toBe(false);
  });

  it("filters columns to known ids and falls back to defaults when none remain", () => {
    const parsed = parseSessionManagerViewState(
      JSON.stringify({ columns: ["name", "not-a-column", "updated"] }),
    );
    expect(parsed.columns).toEqual(["name", "updated"]);
    const empty = parseSessionManagerViewState(JSON.stringify({ columns: ["nope"] }));
    expect(empty.columns).toEqual(SESSION_MANAGER_DEFAULT_VIEW_STATE.columns);
  });

  it("keeps the storage key namespaced and versioned (contract guard)", () => {
    expect(SESSION_MANAGER_VIEW_STORAGE_KEY).toBe("zcode.sessionManager.view.v1");
  });
});

describe("hasActiveSessionManagerFilters", () => {
  it("is false only for the default filter set", () => {
    expect(hasActiveSessionManagerFilters(SESSION_MANAGER_DEFAULT_VIEW_STATE)).toBe(false);
    expect(
      hasActiveSessionManagerFilters({ ...SESSION_MANAGER_DEFAULT_VIEW_STATE, pinnedOnly: true }),
    ).toBe(true);
    // Sort state is not a filter.
    expect(
      hasActiveSessionManagerFilters({
        ...SESSION_MANAGER_DEFAULT_VIEW_STATE,
        sortColumn: "name",
      }),
    ).toBe(false);
  });
});
