// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import { afterEach, describe, expect, it } from "vitest";
import { CallCard } from "@/ModelTrajectoryPaneParts.js";
import { buildTrajectorySearchIndex } from "@/ModelTrajectorySearch.js";
import {
  reconstructTrajectoryRecords,
  resolveTrajectoryTimelineItems,
} from "@/ModelTrajectoryTimeline.js";

const messages: Record<string, string> = {
  "modelTrajectory.inputSection": "Input",
  "modelTrajectory.inputBaseMissing": "Earlier input unavailable",
  "modelTrajectory.role.user": "User",
  "modelTrajectory.role.assistant": "Assistant",
  "modelTrajectory.role.system": "System",
};

const intl = {
  formatMessage: ({ id }: { id: string }) => messages[id] ?? id,
};

afterEach(() => {
  cleanup();
});

function message(role: string, value: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text: value }] };
}

const system = (value: string) => message("system", value);
const user = (value: string) => message("user", value);
const assistant = (value: string) => message("assistant", value);

function call(
  requestId: string,
  input: ZCodeModelTrajectoryMessage[],
  extra: Partial<ZCodeModelTrajectoryRecord> = {},
): ZCodeModelTrajectoryRecord {
  return {
    requestId,
    attempt: 1,
    startedAt: `2026-06-03T12:00:${requestId.slice(1).padStart(2, "0")}.000Z`,
    callSource: { kind: "main" },
    model: { modelId: "glm-test" },
    request: { messages: input, toolNames: [] },
    ...extra,
  };
}

function texts(input: readonly ZCodeModelTrajectoryMessage[]): string[] {
  return input.map((item) =>
    item.parts.map((part) => (part.kind === "text" ? part.text : part.kind)).join(""),
  );
}

describe("trajectory input delta reconstruction", () => {
  const first = call("r1", [system("S"), user("U1")]);
  const second = call("r2", [assistant("A1"), user("U2")], {
    inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
  });
  const third = call("r3", [assistant("A2"), user("U3")], {
    inputDeltaOf: { previousRequestId: "r2", sharedPrefixCount: 4 },
  });

  it("chains each delta onto its base and shares message objects with it", () => {
    const reconstructed = reconstructTrajectoryRecords([first, second, third]);

    expect(reconstructed.map((item) => item.inputContext)).toEqual([
      "full",
      "reconstructed",
      "reconstructed",
    ]);
    expect(texts(reconstructed[2]?.record.request.messages ?? [])).toEqual([
      "S",
      "U1",
      "A1",
      "U2",
      "A2",
      "U3",
    ]);
    expect(reconstructed[2]?.record.request.messages[0]).toBe(first.request.messages[0]);
    expect(reconstructed[1]?.record.request.messages[1]).toBe(first.request.messages[1]);
    // The wire record is not mutated by reconstruction.
    expect(third.request.messages).toHaveLength(2);
  });

  it("shows only new non-assistant rows over reconstructed input and keeps them searchable", () => {
    const items = resolveTrajectoryTimelineItems([first, second, third]);

    expect(texts(items[0]?.inputMessages ?? [])).toEqual(["S", "U1"]);
    expect(texts(items[1]?.inputMessages ?? [])).toEqual(["U2"]);
    expect(texts(items[2]?.inputMessages ?? [])).toEqual(["U3"]);
    expect(items[2]?.record.request.messages).toHaveLength(6);
    expect(items.map((item) => item.inputContext)).toEqual([
      "full",
      "reconstructed",
      "reconstructed",
    ]);

    const index = buildTrajectorySearchIndex(items, "U3");
    expect(index.matches.length).toBeGreaterThan(0);
    expect(index.matches.every((match) => match.callIndex === 2)).toBe(true);
  });

  it("renders a delta with a missing base as its new rows, keeps later counts correct, and never throws", () => {
    const records = [
      first,
      // Base "ghost" is not in the list.
      call("r4", [assistant("A1"), user("U2")], {
        inputDeltaOf: { previousRequestId: "ghost", sharedPrefixCount: 2 },
      }),
      // Chained on the base-missing record, so its own base is unknown too.
      call("r5", [assistant("A2"), user("U3")], {
        inputDeltaOf: { previousRequestId: "r4", sharedPrefixCount: 4 },
      }),
      // Full record after the gap: only the rows after the count it reports are new.
      call("r6", [
        system("S"),
        user("U1"),
        assistant("A1"),
        user("U2"),
        assistant("A2"),
        user("U3"),
        user("U4"),
      ]),
      // A sharedPrefixCount that does not match the base length also counts as a missing base.
      call("r7", [user("U5")], {
        inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 3 },
      }),
    ];

    const items = resolveTrajectoryTimelineItems(records);

    expect(items.map((item) => item.inputContext)).toEqual([
      "full",
      "base-missing",
      "base-missing",
      "full",
      "base-missing",
    ]);
    // Base-missing deltas keep their assistant rows: their base output may not be shown anywhere else.
    expect(texts(items[1]?.inputMessages ?? [])).toEqual(["A1", "U2"]);
    expect(texts(items[2]?.inputMessages ?? [])).toEqual(["A2", "U3"]);
    expect(texts(items[3]?.inputMessages ?? [])).toEqual(["U4"]);
    expect(texts(items[4]?.inputMessages ?? [])).toEqual(["U5"]);
  });

  it("shows the base-missing notice only on cards whose earlier input is unavailable", () => {
    const items = resolveTrajectoryTimelineItems([
      first,
      call("r4", [assistant("A1"), user("U2")], {
        inputDeltaOf: { previousRequestId: "ghost", sharedPrefixCount: 2 },
      }),
      second,
    ]);
    const missing = items[1];
    const reconstructed = items[2];
    if (!missing || !reconstructed) throw new Error("expected two timeline items");
    expect(missing.inputContext).toBe("base-missing");
    expect(reconstructed.inputContext).toBe("reconstructed");

    const { container, rerender } = render(
      createElement(CallCard, {
        record: missing.record,
        index: 1,
        inputMessages: missing.inputMessages,
        inputContext: missing.inputContext,
        intl: intl as never,
      }),
    );
    expect(
      container.querySelector('[data-trajectory-input-context="base-missing"]')?.textContent,
    ).toBe("Earlier input unavailable");

    rerender(
      createElement(CallCard, {
        record: reconstructed.record,
        index: 2,
        inputMessages: reconstructed.inputMessages,
        inputContext: reconstructed.inputContext,
        intl: intl as never,
      }),
    );
    expect(container.querySelector('[data-trajectory-input-context="base-missing"]')).toBeNull();
  });
});
