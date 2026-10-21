// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { createElement } from "react";
import { cleanup } from "@testing-library/react";
import { hasVisibleRealUserFirstInputRow } from "@/v4/conversationProjectionStore.js";
import {
  withAfterFirstUserInputSlot,
  withOptimisticFirstInputRow,
} from "@/v4/conversationTurnUnitSlots.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

afterEach(cleanup);

function optimisticRow(text: string, overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId: -424242,
    turnId: "first-submission:submission-a",
    productTurnId: "first-submission:submission-a",
    entityId: "submission-a",
    kind: "userInput",
    text,
    origin: "realUser",
    sourceCommandId: "command-first",
    createdAt: 1_000,
    createdAtSeq: 0,
    ...overrides,
  };
}

function realUserRow(rowId: number, overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    productTurnId: `turn-${rowId}`,
    entityId: `row-${rowId}`,
    kind: "userInput",
    text: `real message ${rowId}`,
    origin: "realUser",
    sourceCommandId: "command-first",
    createdAt: 2_000,
    createdAtSeq: 1,
    ...overrides,
  };
}

describe("optimistic first-input reconcile predicate (IUX06)", () => {
  it("keeps the optimistic row while no real user row is visible", () => {
    expect(hasVisibleRealUserFirstInputRow([])).toBe(false);
    expect(
      hasVisibleRealUserFirstInputRow([
        { kind: "assistantText", text: "hi", state: "complete" } as unknown as ConversationRow,
      ]),
    ).toBe(false);
  });

  it("hides the optimistic row when the real user row is visible", () => {
    expect(hasVisibleRealUserFirstInputRow([realUserRow(1)])).toBe(true);
  });

  it("hides the optimistic row even when the projection omits sourceCommandId", () => {
    // sourceCommandId is optional on projected rows; a fresh session's first user row is
    // definitionally the first submission, so the fallback must not strand a duplicate.
    expect(hasVisibleRealUserFirstInputRow([realUserRow(1, { sourceCommandId: undefined })])).toBe(
      true,
    );
  });
});

// The timeline composes units as
// withAfterFirstUserInputSlot(withOptimisticFirstInputRow(buildConversationTurnRenderUnits(rows), row), slot)
// — these tests pin that composition (order, slot ownership, reconcile swap) without the
// virtualized DOM layer.
function composeUnits(
  rows: readonly ConversationRow[],
  optimistic: UserInputRow | null,
  slotText?: string,
) {
  const slot = slotText ? createElement("div", { "data-testid": "worktree-slot" }, slotText) : null;
  return withAfterFirstUserInputSlot(
    withOptimisticFirstInputRow(buildConversationTurnRenderUnits(rows), optimistic),
    slot,
  );
}

describe("optimistic first-input turn composition (IUX01/IUX03/IUX06)", () => {
  it("renders the frozen message as its own first timeline unit with the slot beneath it", () => {
    const units = composeUnits([], optimisticRow("Instant first message"), "worktree creating…");
    expect(units).toHaveLength(1);
    const [unit] = units;
    expect(unit.key).toBe("optimistic-first-input");
    expect(unit.timelineOnly).toBe(true);
    expect(unit.visibleUserInputs.map((row) => row.text)).toEqual(["Instant first message"]);
    // The worktree context row renders right after the optimistic bubble (order stability
    // with the post-projection layout, commit 388a7944).
    expect(unit.afterFirstUserInputSlot).toBeTruthy();
  });

  it("stays above transcript rows that are not the user's first row", () => {
    const assistantOnly = [
      { kind: "assistantText", text: "later answer", state: "complete", rowId: 5, turnId: "t5" },
    ] as unknown as ConversationRow[];
    const units = composeUnits(assistantOnly, optimisticRow("Frozen while projecting"));
    expect(units[0]?.key).toBe("optimistic-first-input");
    expect(units[0]?.visibleUserInputs[0]?.text).toBe("Frozen while projecting");
  });

  it("swaps to the projected layout when the real row lands (reconcile, not gate)", () => {
    const rows = [realUserRow(1)];
    const units = composeUnits(rows, null, "worktree created");
    expect(units[0]?.key).not.toBe("optimistic-first-input");
    expect(units[0]?.visibleUserInputs.map((row) => row.text)).toEqual(["real message 1"]);
    // The slot attaches to the first real unit — same position the optimistic unit held.
    expect(units[0]?.afterFirstUserInputSlot).toBeTruthy();
  });

  it("is a no-op without an optimistic row", () => {
    const units = composeUnits([], null);
    expect(units).toHaveLength(0);
  });
});
