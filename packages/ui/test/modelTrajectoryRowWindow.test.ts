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
import { CallCard } from "@/ModelTrajectoryPaneParts.js";
import { TrajectorySearchRevealContext } from "@/ModelTrajectorySearch.js";

const messages: Record<string, string> = {
  "modelTrajectory.showMoreRows": "Show next {count} of {total} messages",
  "modelTrajectory.truncatedAtSource": "Truncated at source, {bytes} bytes",
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
    const { container } = renderCard(userRows(100), {
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

  it("reveals a collapsed row past the page while a search targets it", () => {
    const { container } = renderCard(userRows(100), { revealKey: `${PREFIX}:input:70` });

    expect(mountedRows(container)).toBe(71);
    expect(mountedBodies(container)).toBe(1);
    expect(container.querySelector("[data-trajectory-message-content]")?.textContent).toContain(
      "message 70",
    );
    expect(container.querySelector("[data-trajectory-rows-more]")?.textContent).toBe(
      "Show next 29 of 100 messages",
    );
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
