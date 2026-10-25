// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { resolveContextBudgetTone } from "@zcode/shared";
import type { ConversationRow, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import {
  buildContextSectionModel,
  buildLastTurnSectionModel,
  lastTurnHeaderFacts,
  useLastTurnSectionModel,
} from "../src/status-panel-insights/index.js";

const CUMULATIVE = {
  inputTokens: 2_100_000,
  outputTokens: 84_000,
  cacheReadTokens: 1_800_000,
  cacheWriteTokens: 12_000,
};

function usage(
  contextWindow: Partial<NonNullable<SessionUsageState["contextWindow"]>> | null,
): SessionUsageState {
  return {
    contextWindow:
      contextWindow === null
        ? null
        : {
            usedTokens: 593_000,
            maxTokens: 1_000_000,
            autoCompactThresholdTokens: 967_000,
            autoCompactThresholdAuthoritative: true,
            ...contextWindow,
          },
    cumulative: CUMULATIVE,
  };
}

function turnHeader(
  rowId: number,
  overrides: Record<string, unknown> = {},
  fileChanges?: {
    files: number;
    additions: number;
    deletions: number;
    state?: "active" | "reverted";
  },
): ConversationRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId: `turn-${rowId}`,
    entityId: `entity-${rowId}`,
    createdAt: 1,
    createdAtSeq: rowId,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    ...(fileChanges ? { fileChanges } : {}),
    ...overrides,
  } as ConversationRow;
}

function assistantRow(rowId: number, text: string): ConversationRow {
  return {
    kind: "assistantMessage",
    rowId,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: rowId,
    text,
  } as unknown as ConversationRow;
}

describe("buildContextSectionModel", () => {
  it("returns null when the context window is unknown or not yet reported", () => {
    expect(buildContextSectionModel(null)).toBeNull();
    expect(buildContextSectionModel(usage(null))).toBeNull();
    expect(buildContextSectionModel(usage({ usedTokens: 0 }))).toBeNull();
    expect(buildContextSectionModel(usage({ maxTokens: 0 }))).toBeNull();
  });

  it("derives ratio, authoritative threshold and remaining tokens", () => {
    const model = buildContextSectionModel(usage({}));
    expect(model).toMatchObject({
      usedTokens: 593_000,
      maxTokens: 1_000_000,
      usedRatio: 0.593,
      autoCompactThresholdTokens: 967_000,
      tokensUntilAutoCompact: 374_000,
      breakdown: null,
      cumulative: { inputTokens: 2_100_000, outputTokens: 84_000, cacheReadTokens: 1_800_000 },
    });
  });

  it("hides the threshold when it is not authoritative or disabled", () => {
    expect(
      buildContextSectionModel(usage({ autoCompactThresholdAuthoritative: false })),
    ).toMatchObject({ autoCompactThresholdTokens: null, tokensUntilAutoCompact: null });
    expect(buildContextSectionModel(usage({ autoCompactThresholdTokens: null }))).toMatchObject({
      autoCompactThresholdTokens: null,
      tokensUntilAutoCompact: null,
    });
  });

  it("uses the composer's tone inputs", () => {
    for (const window of [
      { usedTokens: 100_000 },
      { usedTokens: 900_000 },
      { usedTokens: 980_000 },
      { usedTokens: 980_000, autoCompactThresholdAuthoritative: false },
      { usedTokens: 870_000, microcompactThresholdTokens: 860_000 },
    ]) {
      const state = usage(window).contextWindow!;
      // Same expression as V4ComposerToolbar's usageTone.
      const composerTone = resolveContextBudgetTone({
        autoCompactThresholdTokens:
          state.autoCompactThresholdAuthoritative === true
            ? state.autoCompactThresholdTokens
            : undefined,
        contextWindow: state.maxTokens,
        microcompactThresholdTokens: state.microcompactThresholdTokens,
        usedTokens: state.usedTokens,
      });
      expect(buildContextSectionModel(usage(window))?.tone).toBe(composerTone);
    }
  });

  it("keeps the runtime breakdown only when present", () => {
    const breakdown = [{ source: "messages" as const, chars: 1200 }];
    expect(buildContextSectionModel(usage({ breakdown }))?.breakdown).toBe(breakdown);
    expect(buildContextSectionModel(usage({ breakdown: [] }))?.breakdown).toBeNull();
  });
});

describe("buildLastTurnSectionModel", () => {
  it("requires an entity id and file changes", () => {
    expect(buildLastTurnSectionModel(lastTurnHeaderFacts(null))).toBeNull();
    expect(
      buildLastTurnSectionModel(
        lastTurnHeaderFacts(
          turnHeader(3, { entityId: undefined }, { files: 1, additions: 4, deletions: 0 }) as never,
        ),
      ),
    ).toBeNull();
  });

  it("derives request options exactly like the chat turn summary", () => {
    const running = buildLastTurnSectionModel(
      lastTurnHeaderFacts(
        turnHeader(3, { state: "running" }, { files: 2, additions: 9, deletions: 1 }) as never,
      ),
    );
    expect(running).toEqual({
      target: { rowId: 3, entityId: "entity-3" },
      files: 2,
      additions: 9,
      deletions: 1,
      reverted: false,
      requestOptions: { cachePolicy: "in-flight" },
    });
    const reverted = buildLastTurnSectionModel(
      lastTurnHeaderFacts(
        turnHeader(3, {}, { files: 2, additions: 9, deletions: 1, state: "reverted" }) as never,
      ),
    );
    expect(reverted).toMatchObject({
      reverted: true,
      requestOptions: { cachePolicy: "terminal", fileChangesState: "reverted" },
    });
  });
});

describe("useLastTurnSectionModel", () => {
  it("keeps the latest editing turn after a turn without file changes", () => {
    const rows = [turnHeader(1, {}, { files: 1, additions: 4, deletions: 0 }), turnHeader(2)];
    const { result } = renderHook(() => useLastTurnSectionModel(rows));
    expect(result.current?.target).toEqual({ rowId: 1, entityId: "entity-1" });
  });

  it("keeps its identity across streamed deltas that do not change the turn facts", () => {
    const header = turnHeader(1, { state: "running" }, { files: 1, additions: 4, deletions: 0 });
    const { result, rerender } = renderHook(
      ({ rows }: { rows: ConversationRow[] }) => useLastTurnSectionModel(rows),
      { initialProps: { rows: [header, assistantRow(2, "a")] } },
    );
    const first = result.current;
    rerender({ rows: [{ ...header } as ConversationRow, assistantRow(2, "ab")] });
    expect(result.current).toBe(first);

    rerender({
      rows: [
        turnHeader(1, { state: "running" }, { files: 2, additions: 9, deletions: 0 }),
        assistantRow(2, "abc"),
      ],
    });
    expect(result.current).not.toBe(first);
    expect(result.current?.files).toBe(2);
  });

  it("returns null without rows or editing turns", () => {
    expect(renderHook(() => useLastTurnSectionModel(undefined)).result.current).toBeNull();
    expect(renderHook(() => useLastTurnSectionModel([turnHeader(1)])).result.current).toBeNull();
  });
});
