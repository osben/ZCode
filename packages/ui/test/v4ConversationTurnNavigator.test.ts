import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
} from "@/v4/conversationTurnNavigatorHelpers.js";

function baseRow<T extends ConversationRow>(
  row: Omit<T, "createdAt" | "createdAtSeq" | "rowId" | "turnId"> & {
    rowId: number;
    turnId?: string;
  },
): T {
  return {
    createdAt: 1_700_000_000_000 + row.rowId,
    createdAtSeq: row.rowId,
    turnId: row.turnId ?? "turn-1",
    ...row,
  } as T;
}

function turnHeader(
  rowId: number,
  turnId: string,
  overrides: Partial<TurnHeaderRow> = {},
): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 1_000,
    ...overrides,
  });
}

function userInput(
  rowId: number,
  turnId: string,
  text: string,
  origin: UserInputRow["origin"] = "realUser",
  overrides: Partial<UserInputRow> = {},
): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin,
    ...overrides,
  });
}

function assistantText(rowId: number, turnId: string, text: string): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

function reasoning(rowId: number, turnId: string, text: string): ReasoningRow {
  return baseRow<ReasoningRow>({
    rowId,
    turnId,
    kind: "reasoning",
    text,
    state: "complete",
  });
}

function compactMarker(rowId: number, turnId: string): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    turnId,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: "manual",
      status: "success",
    },
  });
}

function units(rows: ConversationRow[]) {
  return buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 });
}

describe("conversation turn navigator helpers", () => {
  it("TN01/TN07：宽 conversation 允许探测完整目录，窄 conversation 零请求", () => {
    const base = {
      canLoadOlder: true,
      containerWidthPx: 864,
      hasLoadHandler: true,
      loadingOlder: false,
    };

    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
        containerWidthPx: 863,
      }),
    ).toBe(false);
    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
      }),
    ).toBe(true);
  });

  it("TN07：暂时失败只安排两次有界退避重试", () => {
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(1)).toBe(250);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(2)).toBe(1_000);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(3)).toBeNull();
  });

  it("TN02/TN06：每条 realUser query 独立建项并共享所属 turn 的 assistant preview", () => {
    const items = buildConversationTurnNavigatorItems(
      units([
        turnHeader(1, "turn-1"),
        userInput(2, "turn-1", "Alpha query"),
        reasoning(3, "turn-1", "private reasoning should not leak"),
        assistantText(
          4,
          "turn-1",
          "Assistant paragraph one has the useful answer.\n\nAssistant paragraph two keeps more context.\n\nAssistant paragraph three should be trimmed.",
        ),
        userInput(5, "turn-1", "Guide query stays separate", "realUser", {
          guided: true,
        }),
        assistantText(6, "turn-1", "Guide answer must not enter preview"),
        compactMarker(7, "marker-only"),
        turnHeader(8, "turn-2", { state: "running", activeMs: undefined }),
        userInput(9, "turn-2", "Gamma running query"),
      ]),
      {
        assistantEmptyPreview: "No assistant text yet",
        assistantRunningPreview: "Assistant is still working",
        maxPreviewChars: 88,
        maxPreviewParagraphs: 2,
        userFallbackPreview: "User turn",
      },
    );

    expect(items.map((item) => item.turnId)).toEqual(["turn-1", "turn-1", "turn-2"]);
    expect(items[0]).toMatchObject({
      unitIndex: 0,
      rowId: 2,
      userPreview: "Alpha query",
      assistantPreviewKind: "text",
      isRunning: false,
    });
    expect(items[1]).toMatchObject({
      unitIndex: 0,
      rowId: 5,
      userPreview: "Guide query stays separate",
      assistantPreviewKind: "text",
      isRunning: false,
    });
    expect(items[2]).toMatchObject({
      unitIndex: 2,
      rowId: 9,
      userPreview: "Gamma running query",
      assistantPreview: "Assistant is still working",
      assistantPreviewKind: "running",
      isRunning: true,
    });
    expect(items[0]?.assistantPreview).toContain("Assistant paragraph one");
    expect(items[0]?.assistantPreview).toContain("Assistant paragraph two");
    expect(items[0]?.assistantPreview).not.toContain("private reasoning");
    expect(items[1]?.assistantPreview).toBe(items[0]?.assistantPreview);
    expect(items.map((item) => item.userPreview).join(" ")).not.toContain("Assistant paragraph");
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
  });

  it("TN05：只为 realUser turn 建目录，排除 assistant-only 与系统 role=user", () => {
    const items = buildConversationTurnNavigatorItems(
      units([
        assistantText(1, "turn-restored", "Restored assistant only body"),
        turnHeader(2, "turn-background", { origin: "backgroundResult" }),
        userInput(3, "turn-background", "system background payload", "backgroundResult"),
        assistantText(4, "turn-background", "Background result"),
        turnHeader(5, "turn-goal", { origin: "goalContinuation" }),
        userInput(6, "turn-goal", "continue goal", "goalContinuation"),
        assistantText(7, "turn-goal", "Goal result"),
        turnHeader(8, "turn-mailbox"),
        userInput(9, "turn-mailbox", "mailbox payload", "mailbox"),
        assistantText(10, "turn-mailbox", "Mailbox result"),
        turnHeader(11, "turn-real"),
        userInput(12, "turn-real", "Actual user query"),
        assistantText(13, "turn-real", "Actual answer"),
      ]),
      {
        assistantEmptyPreview: "No assistant text yet",
        assistantRunningPreview: "Assistant is still working",
        userFallbackPreview: "User turn",
      },
    );

    expect(items).toEqual([
      expect.objectContaining({
        turnId: "turn-real",
        rowId: 12,
        userPreview: "Actual user query",
        assistantPreview: "Actual answer",
      }),
    ]);
  });

  it("resolves the active turn from the currently visible virtual rows", () => {
    const items = [
      { key: "turn-1", turnId: "turn-1", unitIndex: 0 },
      { key: "turn-2", turnId: "turn-2", unitIndex: 4 },
      { key: "turn-3", turnId: "turn-3", unitIndex: 7 },
    ].map((item) => ({
      ...item,
      assistantPreview: "answer",
      assistantPreviewKind: "text" as const,
      isRunning: false,
      rowId: item.unitIndex + 10,
      userPreview: item.turnId,
    }));

    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 390,
        viewportHeightPx: 360,
        virtualItems: [
          { index: 4, start: 360, size: 220 },
          { index: 7, start: 760, size: 160 },
        ],
      }),
    ).toBe(4);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 650,
        viewportHeightPx: 280,
        virtualItems: [
          { index: 5, start: 610, size: 120 },
          { index: 6, start: 730, size: 80 },
        ],
      }),
    ).toBe(7);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 0,
        viewportHeightPx: 400,
        virtualItems: [],
      }),
    ).toBe(0);
  });

  it("TN06：同一 turn 内根据可见 row 锚点解析 active query", () => {
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 330,
        viewportHeightPx: 300,
      }),
    ).toBe(12);
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 520,
        viewportHeightPx: 120,
      }),
    ).toBe(12);
  });

  describe("assistant preview normalisation (golden, bounded scan)", () => {
    const EMPTY = "EMPTY";

    function previewFor(texts: readonly string[]): string {
      const rows: ConversationRow[] = [turnHeader(1, "turn-1"), userInput(2, "turn-1", "Q")];
      texts.forEach((text, index) => rows.push(assistantText(3 + index, "turn-1", text)));
      const items = buildConversationTurnNavigatorItems(units(rows), {
        assistantEmptyPreview: EMPTY,
        assistantRunningPreview: "RUNNING",
        maxPreviewChars: 220,
        maxPreviewParagraphs: 2,
        userFallbackPreview: "USER",
      });
      return items[0]!.assistantPreview;
    }

    /** Reference copy of the pre-bounded algorithm: normalise the whole joined text, then take the first paragraphs and truncate. */
    function legacyPreview(texts: readonly string[]): string {
      const paragraphs = texts
        .join("\n\n")
        .trim()
        .split(/\n\s*\n/u)
        .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
        .filter(Boolean)
        .slice(0, 2);
      if (paragraphs.length === 0) return EMPTY;
      const text = paragraphs.join("\n");
      if (text.length <= 220) return text;
      return `${text.slice(0, 217).trimEnd()}...`;
    }

    it("golden：长多段 assistant 文本只取前两段，输出与全量归一化逐字节一致", () => {
      const long = Array.from(
        { length: 400 },
        (_, index) => `Paragraph ${index} with some words, that keep going for a while.`,
      ).join("\n\n");
      expect(long.length).toBeGreaterThan(4_096);
      expect(previewFor([long])).toBe(
        "Paragraph 0 with some words, that keep going for a while.\nParagraph 1 with some words, that keep going for a while.",
      );
      expect(previewFor([long])).toBe(legacyPreview([long]));
    });

    it("golden：超长首段截断为 217 字符加省略号，与全量归一化一致", () => {
      const longFirst = `${"L".repeat(300)} tail words here.\n\nSecond paragraph that is long too.\n\n${"z".repeat(5_000)}`;
      expect(previewFor([longFirst])).toBe(`${"L".repeat(217)}...`);
      expect(previewFor([longFirst])).toBe(legacyPreview([longFirst]));
    });

    it("golden：短文本保持原输出", () => {
      const short = "好的，我来看一下。\n\n这是**结果**。";
      expect(previewFor([short])).toBe("好的，我来看一下。\n这是**结果**。");
      expect(previewFor([short])).toBe(legacyPreview([short]));
    });

    it("golden：前导空白很长时回退全量归一化，结果与原实现一致", () => {
      const padded = `${" ".repeat(5_000)}hello\n\nworld`;
      expect(previewFor([padded])).toBe("hello\nworld");
      expect(previewFor([padded])).toBe(legacyPreview([padded]));
    });

    it("golden：多条 assistant text 按行拼接后与原实现一致，并在分隔符跨过扫描边界时保持等价", () => {
      let seed = 20_261_022;
      const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
      const alphabet = [
        "a",
        "word",
        " ",
        "  ",
        "\t",
        "\n",
        "\n\n",
        "\n  \n",
        "中文",
        "**",
        "\r\n",
        "x".repeat(50),
        " ".repeat(300),
      ];
      for (let caseIndex = 0; caseIndex < 120; caseIndex += 1) {
        const rowCount = 1 + Math.floor(next() * 3);
        const texts = Array.from({ length: rowCount }, () => {
          const pieces = Math.floor(next() * (caseIndex % 3 === 0 ? 2_000 : 300));
          let text = "";
          for (let index = 0; index < pieces; index += 1) {
            text += alphabet[Math.floor(next() * alphabet.length)];
          }
          return text;
        });
        expect(previewFor(texts), `case ${caseIndex}`).toBe(legacyPreview(texts));
      }
      // A separator straddling the 4096-character scan boundary.
      for (const cut of [4_094, 4_095, 4_096]) {
        const straddle = [`${"a".repeat(cut - 1)}\n\n${"b".repeat(9_000)}`];
        expect(previewFor(straddle)).toBe(legacyPreview(straddle));
      }
    });

    // Killer for an unterminated last piece being treated as terminated: "foo" + spaces + "bar" is one paragraph,
    // so the full text yields "hi\nfoo bar". Its last piece is cut inside the scan prefix, and the prefix alone
    // would yield "hi\nfoo" if that piece were counted as a finished paragraph.
    it("golden：扫描前缀末段未结束时不能提前封口，超过 4096 字符的 'foo'+空格+'bar' 仍为一段", () => {
      const killer = `hi\n\nfoo${" ".repeat(4_090)}bar`;
      expect(killer.length).toBeGreaterThan(4_096);
      expect(previewFor([killer])).toBe("hi\nfoo bar");
      expect(previewFor([killer])).toBe(legacyPreview([killer]));
    });

    // A paragraph separator whose two newlines straddle the 4096-character boundary: the prefix holds only the first
    // newline, so no separator matches inside it. The bounded path declines and the full normalization decides.
    it("golden：段落分隔符的两个换行跨过 4096 边界时，输出与全量归一化一致", () => {
      const straddle = `hi\n\nfoo${" ".repeat(4_088)}\n\nbar`;
      expect(straddle.indexOf("\n\n", 7 + 4_088)).toBe(4_095);
      expect(previewFor([straddle])).toBe("hi\nfoo");
      expect(previewFor([straddle])).toBe(legacyPreview([straddle]));
    });
  });
});
