// The stateless query forwarding surface of ReplaceableConversationTransport.
//
// This class is the pane side's **stable identity**: when the remote service proxy changes generation, existing
// panes keep holding the same object, so every new ConversationTransport member must grow a corresponding
// forwarding method here. Missing one does not fail loudly on the pane side — that query simply becomes
// undefined and the feature quietly does not exist. workflowRunEvents (the dwf run event-log paging) missed once,
// which is why it has a case here.
import { describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ReplaceableConversationTransport } from "../src/v4/replaceableConversationTransport.js";
import type { ConversationTransport } from "../src/v4/transport.js";

// The stub only carries workflowRunEvents: this forwarding is stateless (it does not consult the subscription
// ownership map) and replace touches none of the interface's other members (the subscription map and listener set
// are empty). Filling in a whole interface would only drown out what the case is testing.
function stubTransport(result: V4ConversationWorkflowRunEventsResult) {
  const workflowRunEvents = vi.fn(async () => result);
  return {
    workflowRunEvents,
    transport: { workflowRunEvents } as unknown as ConversationTransport,
  };
}

const firstPage: V4ConversationWorkflowRunEventsResult = {
  events: [{ sequence: 7, type: "run.started", payload: { runId: "dwfrun-1" } }],
  hasMore: true,
};
const secondPage: V4ConversationWorkflowRunEventsResult = { events: [], hasMore: false };

describe("ReplaceableConversationTransport workflowRunEvents", () => {
  it("原样转发给当前 transport，params 一个字段不动", async () => {
    const first = stubTransport(firstPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);
    const params = { sessionId: "session-1", runId: "dwfrun-1", afterSequence: 6, limit: 50 };

    await expect(replaceable.workflowRunEvents(params)).resolves.toEqual(firstPage);
    expect(first.workflowRunEvents).toHaveBeenCalledWith(params);
  });

  it("replace 之后转发给新 transport，旧的不再被打", async () => {
    const first = stubTransport(firstPage);
    const second = stubTransport(secondPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);

    replaceable.replace(second.transport);
    const params = { sessionId: "session-1", runId: "dwfrun-1" };

    await expect(replaceable.workflowRunEvents(params)).resolves.toEqual(secondPage);
    expect(second.workflowRunEvents).toHaveBeenCalledWith(params);
    expect(first.workflowRunEvents).not.toHaveBeenCalled();
  });
});

// workflowRuns (dwf run enumeration, the post-restart discovery surface): the same missed-forwarding risk as
// workflowRunEvents; when the interface gains a member, a forwarding method must grow here in sync (the file-header rule).
function stubRunsTransport(result: V4ConversationWorkflowRunsResult) {
  const workflowRuns = vi.fn(async () => result);
  return {
    workflowRuns,
    transport: { workflowRuns } as unknown as ConversationTransport,
  };
}

const runsPage: V4ConversationWorkflowRunsResult = {
  runs: [
    {
      runId: "dwfrun-1",
      toolCallId: "call-1",
      status: "cancelled",
      resumable: true,
    },
  ],
};
const emptyRuns: V4ConversationWorkflowRunsResult = { runs: [] };

describe("ReplaceableConversationTransport workflowRuns", () => {
  it("原样转发给当前 transport", async () => {
    const first = stubRunsTransport(runsPage);
    const replaceable = new ReplaceableConversationTransport(first.transport);
    const params = { sessionId: "session-1", limit: 8 };

    await expect(replaceable.workflowRuns(params)).resolves.toEqual(runsPage);
    expect(first.workflowRuns).toHaveBeenCalledWith(params);
  });

  it("replace 之后转发给新 transport，旧的不再被打", async () => {
    const first = stubRunsTransport(runsPage);
    const second = stubRunsTransport(emptyRuns);
    const replaceable = new ReplaceableConversationTransport(first.transport);

    replaceable.replace(second.transport);
    const params = { sessionId: "session-1" };

    await expect(replaceable.workflowRuns(params)).resolves.toEqual(emptyRuns);
    expect(second.workflowRuns).toHaveBeenCalledWith(params);
    expect(first.workflowRuns).not.toHaveBeenCalled();
  });
});

// The three read surfaces of dwf user-facing artifacts (docs/dynamic-workflow/authoring.md): the same
// missed-forwarding risk as the two above.
// ⚠ Terminology: artifact = an output the script published for the user to see via `artifact.*`, not the run's top-level return value.
//
// These three are worth pinning even more than the previous two: missing workflowRunArtifactRead presents as "a
// card on the side pane, empty when opened" rather than an explicit error — the card comes from the state-key
// projection (not through this class) while only the bytes travel over the transport.
describe("ReplaceableConversationTransport user-facing artifact and script transcript forwarding", () => {
  /**
   * All three tested together: writing "verbatim forwarding + hit the new one after replace" per method would be
   * six nearly identical cases, while the single thing to prove is — **every member of the interface has a forwarding method on this stable identity**.
   */
  const cases = [
    {
      method: "workflowRunArtifacts" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1" },
      first: { artifacts: [] },
      second: {
        artifacts: [
          {
            id: "book",
            kind: "file" as const,
            version: 1,
            versions: [{ version: 1, publishedAt: 1 }],
            itemCount: 0,
          },
        ],
      },
    },
    {
      method: "workflowRunArtifactData" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1", artifactId: "perf", limit: 200 },
      first: { items: [], hasMore: false },
      second: {
        items: [{ sequence: 3, siteId: "report#1", ordinal: 1, item: { round: 1 } }],
        hasMore: true,
      },
    },
    {
      method: "workflowRunArtifactRead" as const,
      params: {
        sessionId: "session-1",
        runId: "dwfrun-1",
        artifactId: "book",
        version: 1,
        offset: 0,
        limit: 4,
      },
      first: { dataBase64: "", mediaType: "application/pdf", totalBytes: 0, nextOffset: null },
      second: {
        dataBase64: "aGVsbG8=",
        mediaType: "application/pdf",
        totalBytes: 5,
        nextOffset: null,
      },
    },
    // The two read surfaces of the script transcript (docs/dynamic-workflow/transcript-and-notifications.md "Two read queries"):
    // the same missed-forwarding risk as artifacts — missing the list means "the panel spins forever", missing the body means "the card expands empty".
    {
      method: "workflowRunWorkspace" as const,
      params: { sessionId: "session-1", runId: "dwfrun-1" },
      first: { nodes: [] },
      second: {
        nodes: [
          {
            siteId: "world-read#1",
            ordinal: 1,
            kind: "world-read" as const,
            op: "read",
            args: ["src/a.ts"],
            status: "completed" as const,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        truncated: true,
      },
    },
    {
      method: "workflowRunNodeResult" as const,
      params: {
        sessionId: "session-1",
        runId: "dwfrun-1",
        siteId: "world-read#1",
        ordinal: 1,
        maxBytes: 4096,
      },
      first: { status: "running" as const, truncated: false, totalBytes: 0 },
      second: {
        status: "completed" as const,
        result: "export {};\n",
        truncated: false,
        totalBytes: 11,
      },
    },
  ];

  it.each(cases)("$method 原样转发给当前 transport，params 一个字段不动", async (testCase) => {
    const forward = vi.fn(async () => testCase.first);
    const transport = { [testCase.method]: forward } as unknown as ConversationTransport;
    const replaceable = new ReplaceableConversationTransport(transport);

    await expect(
      (replaceable[testCase.method] as (params: unknown) => Promise<unknown>)(testCase.params),
    ).resolves.toEqual(testCase.first);
    expect(forward).toHaveBeenCalledWith(testCase.params);
  });

  it.each(cases)("$method replace 之后转发给新 transport，旧的不再被打", async (testCase) => {
    const firstForward = vi.fn(async () => testCase.first);
    const secondForward = vi.fn(async () => testCase.second);
    const replaceable = new ReplaceableConversationTransport({
      [testCase.method]: firstForward,
    } as unknown as ConversationTransport);

    replaceable.replace({ [testCase.method]: secondForward } as unknown as ConversationTransport);
    await expect(
      (replaceable[testCase.method] as (params: unknown) => Promise<unknown>)(testCase.params),
    ).resolves.toEqual(testCase.second);
    expect(secondForward).toHaveBeenCalledWith(testCase.params);
    expect(firstForward).not.toHaveBeenCalled();
  });
});
