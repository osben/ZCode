// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  createTrajectoryExpansionCommands,
  TrajectoryExpansionCommandContext,
  TrajectoryExpansionRegistryContext,
  type TrajectoryExpansionRegistry,
} from "@/ModelTrajectoryExpansion.js";
import { resolveInputRowWindow } from "@/ModelTrajectoryExpansion.js";
import { CallCard } from "@/ModelTrajectoryPaneParts.js";
import {
  buildTrajectorySearchIndex,
  TrajectorySearchRevealContext,
} from "@/ModelTrajectorySearch.js";

const messages: Record<string, string> = {
  "modelTrajectory.showMoreRows": "Show next {count} of {total} messages",
  "modelTrajectory.truncatedAtSource": "Truncated at source, {bytes} bytes",
  "modelTrajectory.rowsHidden": "{count} rows hidden",
};

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, String(value)),
      messages[id] ?? id,
    ),
} as never;

const PREFIX = "req-card:0";

afterEach(() => {
  cleanup();
});

function userRows(count: number): ZCodeModelTrajectoryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "user",
    parts: [{ kind: "text" as const, text: `message ${index}` }],
  }));
}

function record(): ZCodeModelTrajectoryRecord {
  return {
    requestId: "req-card",
    attempt: 1,
    startedAt: "2026-06-03T00:00:00.000Z",
    model: {},
    request: { messages: [], toolNames: [] },
  };
}

function registry(
  overrides: Partial<TrajectoryExpansionRegistry> = {},
): TrajectoryExpansionRegistry {
  return {
    overrides: new Map(),
    setOverride: vi.fn(),
    rowLimits: new Map(),
    setRowLimit: vi.fn(),
    ...overrides,
  };
}

function renderCard(
  inputMessages: ZCodeModelTrajectoryMessage[],
  {
    commands = createTrajectoryExpansionCommands(),
    reg = null,
    revealKey = null,
  }: {
    commands?: ReturnType<typeof createTrajectoryExpansionCommands>;
    reg?: TrajectoryExpansionRegistry | null;
    revealKey?: string | null;
  } = {},
) {
  return render(
    createElement(
      TrajectoryExpansionCommandContext.Provider,
      { value: commands },
      createElement(
        TrajectoryExpansionRegistryContext.Provider,
        { value: reg },
        createElement(
          TrajectorySearchRevealContext.Provider,
          { value: revealKey },
          createElement(CallCard, {
            record: record(),
            index: 0,
            inputMessages,
            expansionKeyPrefix: PREFIX,
            intl,
          }),
        ),
      ),
    ),
  );
}

// Row rows are always mounted as <collapsible>; only an open row mounts its body (data-trajectory-message-content).
function mountedRows(container: HTMLElement) {
  return container.querySelectorAll("[data-trajectory-message-collapsible]").length;
}
function mountedBodies(container: HTMLElement) {
  return container.querySelectorAll("[data-trajectory-message-content]").length;
}

describe("resolveInputRowWindow", () => {
  it("windows a far hit with a radius around it and reports both gaps", () => {
    expect(resolveInputRowWindow({ total: 1000, limit: 40, revealIndex: 900 })).toEqual({
      pageEnd: 40,
      revealStart: 890,
      revealEnd: 911,
      hiddenBefore: 850,
      hiddenAfter: 89,
      windowed: true,
    });
  });

  it("adds no window for a hit already on the page or beyond the card", () => {
    expect(resolveInputRowWindow({ total: 100, limit: 40, revealIndex: 10 }).windowed).toBe(false);
    expect(resolveInputRowWindow({ total: 100, limit: 40, revealIndex: 100 }).windowed).toBe(false);
  });

  it("starts the window at the page end when the hit is just past it", () => {
    expect(resolveInputRowWindow({ total: 100, limit: 40, revealIndex: 40 })).toMatchObject({
      revealStart: 40,
      hiddenBefore: 0,
      windowed: true,
    });
  });
});

describe("CallCard input row window", () => {
  it("keeps a card with 40 input rows all expanded and mounted", () => {
    const { container } = renderCard(userRows(40));

    expect(mountedRows(container)).toBe(40);
    expect(mountedBodies(container)).toBe(40);
    expect(container.querySelector("[data-trajectory-rows-more]")).toBeNull();
  });

  it("starts a card with 41 input rows collapsed and mounts only the first page without bodies", () => {
    const { container } = renderCard(userRows(41));

    expect(mountedRows(container)).toBe(40);
    expect(mountedBodies(container)).toBe(0);
    expect(container.querySelectorAll("pre").length).toBe(0);
    const more = container.querySelector("[data-trajectory-rows-more]");
    expect(more?.textContent).toBe("Show next 1 of 41 messages");
  });

  it("mounts the next page when show-next is clicked, using local state without a registry", () => {
    const { container } = renderCard(userRows(100));
    expect(mountedRows(container)).toBe(40);

    fireEvent.click(container.querySelector("[data-trajectory-rows-more]") as Element);

    expect(mountedRows(container)).toBe(80);
  });

  it("uses the registry-owned row limit when one is provided", () => {
    const setRowLimit = vi.fn();
    const { container } = renderCard(userRows(200), {
      reg: registry({ rowLimits: new Map([[PREFIX, 80]]), setRowLimit }),
    });
    expect(mountedRows(container)).toBe(80);

    fireEvent.click(container.querySelector("[data-trajectory-rows-more]") as Element);

    expect(setRowLimit).toHaveBeenCalledWith(PREFIX, 120);
  });

  it("applies a batch expand command to the mounted rows of a collapsed card", () => {
    const commands = createTrajectoryExpansionCommands();
    commands.user = { expanded: true, version: 1 };
    const { container } = renderCard(userRows(41), { commands });

    expect(mountedBodies(container)).toBe(40);
  });

  it("does not apply a non-matching batch command to collapsed rows", () => {
    const commands = createTrajectoryExpansionCommands();
    commands.assistant = { expanded: true, version: 1 };
    const { container } = renderCard(userRows(41), { commands });

    expect(mountedBodies(container)).toBe(0);
  });

  it("reveals a collapsed row past the page with a window, not a prefix up to the row", () => {
    const { container } = renderCard(userRows(100), { revealKey: `${PREFIX}:input:70` });

    // Page [0,40) plus window [60,81); rows 40..59 and 81..99 are gap rows.
    expect(mountedRows(container)).toBe(61);
    expect(mountedBodies(container)).toBe(1);
    expect(container.querySelector("[data-trajectory-message-content]")?.textContent).toContain(
      "message 70",
    );
    expect(container.querySelector("[data-trajectory-rows-more]")?.textContent).toBe(
      "Show next 20 of 100 messages",
    );
    expect(container.querySelector("[data-trajectory-rows-hidden]")?.textContent).toBe(
      "19 rows hidden",
    );
  });

  it("mounts a page plus a 21-row window for a hit at row 900 of 1000, not 901 rows", () => {
    const { container } = renderCard(userRows(1000), { revealKey: `${PREFIX}:input:900` });

    expect(mountedRows(container)).toBe(61);
    expect(container.querySelector("[data-trajectory-message-content]")?.textContent).toContain(
      "message 900",
    );
  });

  it("makes the show-next label count exactly the rows the click mounts", () => {
    const { container } = renderCard(userRows(100), { revealKey: `${PREFIX}:input:70` });
    const before = mountedRows(container);
    const label = container.querySelector("[data-trajectory-rows-more]")?.textContent ?? "";
    const claimed = Number(/Show next (\d+) of/.exec(label)?.[1]);

    fireEvent.click(container.querySelector("[data-trajectory-rows-more]") as Element);

    expect(mountedRows(container) - before).toBe(claimed);
  });

  it("keeps the mixed text of an assistant input row that also has a tool call", () => {
    const messagesWithMixed: ZCodeModelTrajectoryMessage[] = [
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "history text stays visible" },
          { kind: "tool-call", toolName: "Read", toolCallId: "call_1", input: { path: "a" } },
        ],
      },
    ];
    const commands = createTrajectoryExpansionCommands();
    commands.assistant = { expanded: true, version: 1 };
    commands["tool-call"] = { expanded: true, version: 1 };
    const { container } = renderCard(messagesWithMixed, { commands });

    expect(container.textContent).toContain("history text stays visible");
  });

  it("renders the truncation notice for a cut response text in the output section", () => {
    const cutRecord = {
      ...record(),
      response: {
        finishReason: "stop",
        text: "head\n…\ntail",
        reasoningText: "short thought",
        toolCalls: [],
        truncated: { text: { originalBytes: 20000, omittedBytes: 3616 } },
      },
    } as ZCodeModelTrajectoryRecord;
    const { container } = render(
      createElement(
        TrajectoryExpansionCommandContext.Provider,
        { value: createTrajectoryExpansionCommands() },
        createElement(CallCard, {
          record: cutRecord,
          index: 0,
          inputMessages: [],
          expansionKeyPrefix: PREFIX,
          intl,
        }),
      ),
    );

    const output = container.querySelector("[data-trajectory-response-section]");
    expect(output?.querySelectorAll("[data-trajectory-truncated]").length).toBe(1);
    expect(output?.querySelector("[data-trajectory-truncated]")?.textContent).toBe(
      "Truncated at source, 20000 bytes",
    );
    expect(output?.textContent).not.toContain("short thought\n…\n");
  });

  it("renders the explicit truncation notice for a cut segment", () => {
    const cut: ZCodeModelTrajectoryMessage[] = [
      {
        role: "user",
        parts: [
          {
            kind: "text",
            text: "head\n…\ntail",
            truncated: { originalBytes: 20000, omittedBytes: 3616 },
          },
        ],
      },
    ];
    const { container } = renderCard(cut);

    expect(container.querySelector("[data-trajectory-truncated]")?.textContent).toBe(
      "Truncated at source, 20000 bytes",
    );
  });
});

describe("mixed text and tool-call messages", () => {
  const mixed: ZCodeModelTrajectoryMessage[] = [
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "needle in the text part" },
        { kind: "tool-call", toolName: "Read", toolCallId: "call_m", input: { path: "haystack" } },
      ],
    },
  ];

  it("indexes the text part of a mixed message, not only its tool input", () => {
    const index = buildTrajectorySearchIndex(
      [{ key: PREFIX, record: record(), inputMessages: mixed }],
      "needle",
    );

    expect(index.matches.length).toBe(1);
  });

  it("previews the text part before the tool input of a mixed message", () => {
    const { container } = renderCard(mixed);

    const preview = container.querySelector("[data-trajectory-message-preview]")?.textContent ?? "";
    expect(preview.startsWith("needle in the text part")).toBe(true);
    expect(preview).toContain("haystack");
  });
});
