// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTrajectoryV2Model } from "@/model-trajectory-v2/app/useTrajectoryV2Model.js";
import { RequestPayload } from "@/model-trajectory-v2/components/TrajectoryInspectorSections.js";
import type {
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2Record,
} from "@/model-trajectory-v2/contract.js";

const intl = { formatMessage: ({ id }: { id: string }) => id };

afterEach(() => {
  cleanup();
});

function message(role: string, text: string): ZCodeModelTrajectoryMessage {
  return { role, parts: [{ kind: "text", text }] };
}

function record(
  requestId: string,
  messages: ZCodeModelTrajectoryMessage[],
  over: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt: "2026-06-03T12:00:00.000Z",
    callSource: { kind: "main" },
    model: { modelId: "glm-test", providerId: "zai" },
    request: {
      messages,
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: true,
    },
    ...over,
  };
}

const deltaRecord = record("r2", [message("assistant", "A1"), message("user", "U2")], {
  inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 1 },
});

const trajectory: ZCodeModelTrajectoryV2 = {
  taskId: "task-1",
  available: true,
  truncated: false,
  sourceFiles: [],
  records: [record("r1", [message("user", "U1")]), deltaRecord],
  toolDefs: {},
  toolCatalogs: {},
  systemBlocks: {},
  systemPrompts: {},
  contextWindows: [],
  toolTiming: { source: "session-db", entries: [] },
  budget: { toolDefBytes: 0, systemBytes: 0, omitted: false },
};

function DeltaRequestPayload({ data = trajectory }: { data?: ZCodeModelTrajectoryV2 }) {
  const model = useTrajectoryV2Model(data, false);
  const recordIndex = data.records.indexOf(deltaRecord);
  const row = model.rows.find(
    (item) => item.kind === "request" && item.recordIndex === recordIndex,
  );
  if (row?.kind !== "request") return null;
  return <RequestPayload row={row} model={model} intl={intl} />;
}

function openMessages(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("details"))
    .filter((details) => details.open)
    .map((details) => details.querySelector("pre")?.textContent ?? "");
}

describe("trajectory v2 request payload", () => {
  it("keeps the same message expanded when switching between new and full input", () => {
    const { container, getByText } = render(<DeltaRequestPayload />);
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(2);
    details[1]!.open = true;
    expect(openMessages(container)).toEqual(["U2"]);

    fireEvent.click(getByText("modelTrajectoryV2.payload.showFull"));
    expect(container.querySelectorAll("details")).toHaveLength(3);
    expect(openMessages(container)).toEqual(["U2"]);

    fireEvent.click(getByText("modelTrajectoryV2.payload.showNew"));
    expect(openMessages(container)).toEqual(["U2"]);
  });

  it("keeps the expanded message when the delta base is missing", () => {
    const { container, getByText } = render(
      <DeltaRequestPayload data={{ ...trajectory, records: [deltaRecord] }} />,
    );
    container.querySelectorAll("details")[1]!.open = true;

    fireEvent.click(getByText("modelTrajectoryV2.payload.showFull"));
    expect(openMessages(container)).toEqual(["U2"]);
  });
});
