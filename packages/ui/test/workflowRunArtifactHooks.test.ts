// @vitest-environment jsdom

// The three data fetches for user-facing artifacts (docs/dynamic-workflow/authoring.md, "How the user sees them"):
//
//   metadata  useWorkflowRunArtifacts     live-projection summary + journal full set (only the latter has spec / versions)
//   items     useWorkflowRunArtifactData  incremental continuation whenever itemCount rises (boards are a projection of the journal)
//   bytes     useWorkflowRunArtifactBytes chunked assembly into Uint8Array -> Blob -> objectUrl (revoked on unmount)
//
// Terminology warning: artifact here means outputs the script publishes for the user to see via
// `artifact.*`, not the engine's same-named "top-level return value of the script" (the spec's terminology table).
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  WorkflowRunArtifact,
  WorkflowRunArtifactSummary,
} from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const workflowRunArtifacts =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactsParams,
    ) => Promise<V4ConversationWorkflowRunArtifactsResult>
  >();
const workflowRunArtifactData =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactDataParams,
    ) => Promise<V4ConversationWorkflowRunArtifactDataResult>
  >();
const workflowRunArtifactRead =
  vi.fn<
    (
      params: V4ConversationWorkflowRunArtifactReadParams,
    ) => Promise<V4ConversationWorkflowRunArtifactReadResult>
  >();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    workflowRunArtifacts,
    workflowRunArtifactData,
    workflowRunArtifactRead,
  }),
}));

// eslint-disable-next-line import/first -- The hook under test must be imported after the context mock.
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
// eslint-disable-next-line import/first
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
// eslint-disable-next-line import/first
import {
  encodeBytesToBase64,
  useWorkflowRunArtifactBytes,
} from "@/hooks/useWorkflowRunArtifactBytes.js";

const SESSION = "parent-a";
const RUN = "dwfrun-1";

function journalRecord(overrides: Partial<WorkflowRunArtifact> = {}): WorkflowRunArtifact {
  return {
    id: "perf",
    kind: "chart",
    version: 1,
    versions: [
      { version: 1, publishedAt: 10, spec: { x: { field: "round" }, y: { field: "ms" } } },
    ],
    spec: { x: { field: "round" }, y: { field: "ms" } },
    itemCount: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<WorkflowRunArtifactSummary> = {}): WorkflowRunArtifactSummary {
  return { id: "perf", kind: "chart", version: 1, itemCount: 0, ...overrides };
}

function itemsPage(
  from: number,
  count: number,
  hasMore: boolean,
): V4ConversationWorkflowRunArtifactDataResult {
  return {
    items: Array.from({ length: count }, (_unused, index) => ({
      sequence: from + index,
      siteId: "report#1",
      ordinal: from + index,
      item: { round: from + index, ms: 100 + index },
    })),
    hasMore,
  };
}

beforeEach(() => {
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactRead.mockReset();
  workflowRunArtifacts.mockResolvedValue({ artifacts: [] });
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
});

describe("useWorkflowRunArtifacts", () => {
  it("run 在活投影里：顺序与新鲜度归摘要，spec / versions 由 journal 补齐", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [journalRecord({ id: "book", kind: "file", spec: undefined }), journalRecord()],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        live: [summary({ itemCount: 3 }), summary({ id: "book", kind: "file" })],
      }),
    );

    // What we wait for is the **journal half**: the live projection already provides both entries,
    // so `toHaveLength(2)` holds on the first frame; using it as the gate would assert spec before
    // the query returns under heavy load (a case that only turns red when fully loaded).
    await waitFor(() => expect(hook.result.current.artifacts[0]?.spec).toBeDefined());
    expect(hook.result.current.artifacts).toHaveLength(2);
    // Order follows the live projection (perf first), not the order the journal returned.
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual(["perf", "book"]);
    expect(hook.result.current.source).toBe("live");
    // itemCount comes from the live projection (the refresh signal — one beat behind means one fewer dot drawn); spec exists only in the journal.
    expect(hook.result.current.artifacts[0]?.itemCount).toBe(3);
    expect(hook.result.current.artifacts[0]?.spec).toEqual({
      x: { field: "round" },
      y: { field: "ms" },
    });
    expect(hook.result.current.artifacts[0]?.versions).toHaveLength(1);
  });

  it("run 不在活投影里（冷恢复 / 被 8-run 上限淘汰）：整份清单走 journal", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord({
          id: "audit",
          kind: "file",
          spec: undefined,
          version: 2,
          versions: [
            { version: 1, publishedAt: 1, bytes: 10 },
            { version: 2, publishedAt: 2, bytes: 4096, contentType: "application/pdf" },
          ],
          contentType: "application/pdf",
        }),
      ],
    });
    const hook = renderHook(() => useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN }));

    await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(1));
    expect(hook.result.current.source).toBe("journal");
    // Journal entries carry no bytes (bytes hang on versions) — taken from the latest version.
    expect(hook.result.current.artifacts[0]?.bytes).toBe(4096);
    expect(hook.result.current.artifacts[0]?.version).toBe(2);
  });

  it("投影上界 32 拒新之后，journal 里多出来的产物仍然追加在末尾", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord(),
        journalRecord({ id: "extra", kind: "markdown", spec: undefined }),
      ],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: [summary()] }),
    );

    await waitFor(() => expect(hook.result.current.artifacts).toHaveLength(2));
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual(["perf", "extra"]);
  });

  // Deliverable (docs/dynamic-workflow/authoring.md, "Ids, tags and versions"): the live projection upserts in publication order; this is its only ordering point.
  it("交付物带头（活投影把它排在第三也一样），旗子两个来源任一带上即算；其余保持发布顺序", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        journalRecord(),
        journalRecord({ id: "notes", kind: "markdown", spec: undefined }),
        journalRecord({
          id: "report",
          kind: "markdown",
          spec: undefined,
          description: "结论与修复建议",
          primary: true,
        }),
      ],
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        // The live projection's summary **lacks** the primary flag (old CLI): after the journal fills it in, report still leads.
        live: [
          summary(),
          summary({ id: "notes", kind: "markdown" }),
          summary({ id: "report", kind: "markdown" }),
        ],
      }),
    );
    await waitFor(() => expect(hook.result.current.artifacts[0]?.id).toBe("report"));
    expect(hook.result.current.artifacts.map((artifact) => artifact.id)).toEqual([
      "report",
      "perf",
      "notes",
    ]);
    expect(hook.result.current.artifacts[0]?.primary).toBe(true);
    expect(hook.result.current.artifacts[0]?.description).toBe("结论与修复建议");
    expect("primary" in hook.result.current.artifacts[1]!).toBe(false);

    // Only the live projection carries the flag (journal not back yet): it leads from the first frame.
    const liveOnly = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: "dwfrun-2",
        live: [summary(), summary({ id: "report", kind: "markdown", primary: true })],
      }),
    );
    expect(liveOnly.result.current.artifacts.map((artifact) => artifact.id)).toEqual([
      "report",
      "perf",
    ]);
  });

  it("能力缺席不是错误：内容产物仍从活投影列得出来，只是 unavailable 抬起", async () => {
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const hook = renderHook(() =>
      useWorkflowRunArtifacts({
        sessionId: SESSION,
        runId: RUN,
        live: [summary({ id: "book", kind: "file", bytes: 12 })],
      }),
    );

    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.artifacts).toHaveLength(1);
    expect(hook.result.current.artifacts[0]?.spec).toBeUndefined();
  });

  // The completion card's `+N` uses it to decide between writing a number and an ellipsis (docs/dynamic-workflow/transcript-and-notifications.md, "The card").
  it("complete：活投影在场即完整（上界 32 = 引擎上限）；冷路径要等 journal 答过；能力缺席永不完整", async () => {
    const live = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: [summary()] }),
    );
    expect(live.result.current.complete).toBe(true);

    let resolve!: (value: { artifacts: WorkflowRunArtifact[] }) => void;
    workflowRunArtifacts.mockImplementation(
      () => new Promise<{ artifacts: WorkflowRunArtifact[] }>((r) => (resolve = r)),
    );
    const cold = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: "dwfrun-c" }),
    );
    expect(cold.result.current.complete).toBe(false);
    resolve({ artifacts: [journalRecord()] });
    await waitFor(() => expect(cold.result.current.complete).toBe(true));

    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const old = renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: "dwfrun-o" }),
    );
    await waitFor(() => expect(old.result.current.unavailable).toBe(true));
    expect(old.result.current.complete).toBe(false);
  });

  it("itemCount 变化**不**重查 journal，版本抬升才重查", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [journalRecord()] });
    const hook = renderHook(
      (props: { live: readonly WorkflowRunArtifactSummary[] }) =>
        useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, live: props.live }),
      {
        initialProps: {
          live: [summary({ itemCount: 1 })] as readonly WorkflowRunArtifactSummary[],
        },
      },
    );
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalledTimes(1));

    hook.rerender({ live: [summary({ itemCount: 2 })] });
    await act(async () => {});
    expect(workflowRunArtifacts).toHaveBeenCalledTimes(1);

    hook.rerender({ live: [summary({ itemCount: 2, version: 2 })] });
    await waitFor(() => expect(workflowRunArtifacts).toHaveBeenCalledTimes(2));
  });

  it("enabled 为 false 时一次都不查", async () => {
    renderHook(() =>
      useWorkflowRunArtifacts({ sessionId: SESSION, runId: RUN, enabled: false, live: [] }),
    );
    await act(async () => {});
    expect(workflowRunArtifacts).not.toHaveBeenCalled();
  });
});

describe("useWorkflowRunArtifactData", () => {
  it("首次整份重取，hasMore 为真就一路翻到排空", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      .mockResolvedValueOnce(itemsPage(3, 1, false));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(1, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      limit: 200,
    });
    // The second page continues from the last sequence of the previous page — no overlap, no gaps.
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 2,
      limit: 200,
    });
  });

  it("翻页没有 16 页的上限：一个已结束、打了 5,000 条标签的 run 看板画出全部条目", async () => {
    // Before the fix it stopped after at most 16 pages x 200 = 3,200 items, while a finished run never gets another itemCount change to continue pulling.
    const total = 5_000;
    const pages = Math.ceil(total / 200);
    for (let page = 0; page < pages; page += 1) {
      const from = 1 + page * 200;
      const count = Math.min(200, total - page * 200);
      workflowRunArtifactData.mockResolvedValueOnce(itemsPage(from, count, page < pages - 1));
    }
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(total));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(pages);
    expect(hook.result.current.items.at(-1)?.sequence).toBe(total);
  });

  it("一页没有让游标前进就停：一个总说 hasMore 的实现锁不死渲染线程", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      // The same sequence range comes again and still claims more: the cursor did not advance.
      .mockResolvedValueOnce(itemsPage(1, 2, true))
      .mockResolvedValue(itemsPage(1, 2, true));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(2);
  });

  it("给了 fields 就只让 CLI 取这些字段", async () => {
    workflowRunArtifactData.mockResolvedValueOnce({
      items: [{ sequence: 1, siteId: "report#1", ordinal: 1, fields: { round: 1 } }],
      hasMore: false,
    });
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: "parent-fields",
        runId: RUN,
        artifactId: "perf",
        fields: ["round", "ms"],
      }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(workflowRunArtifactData).toHaveBeenCalledWith({
      sessionId: "parent-fields",
      runId: RUN,
      artifactId: "perf",
      limit: 200,
      fields: ["round", "ms"],
    });
    expect(hook.result.current.items[0]?.fields).toEqual({ round: 1 });
  });

  it("老 CLI 拒收 fields 时退回取整条 item，并记住这个会话", async () => {
    // The old CLI's strict schema rejects the whole request containing fields; after crossing JSON-RPC only the zod message remains.
    const rejection = new Error(
      '[{"code":"unrecognized_keys","keys":["fields"],"path":[],"message":"Unrecognized key: \\"fields\\""}]',
    );
    workflowRunArtifactData
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(itemsPage(1, 1, false))
      .mockResolvedValueOnce(itemsPage(1, 1, false));
    const request = { sessionId: "parent-old-cli", runId: RUN, artifactId: "perf" };
    const first = renderHook(() => useWorkflowRunArtifactData({ ...request, fields: ["round"] }));
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    expect(first.result.current.error).toBeNull();
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(1, {
      ...request,
      limit: 200,
      fields: ["round"],
    });
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(2, { ...request, limit: 200 });

    // The next board in the same session no longer hits the rejection once more.
    const second = renderHook(() =>
      useWorkflowRunArtifactData({ ...request, artifactId: "perf", fields: ["round"] }),
    );
    await waitFor(() => expect(second.result.current.items).toHaveLength(1));
    expect(workflowRunArtifactData).toHaveBeenNthCalledWith(3, { ...request, limit: 200 });
  });

  it("别的错误照常报出来，不当成老 CLI", async () => {
    workflowRunArtifactData.mockRejectedValueOnce(new Error("fault.workflowRunArtifactData.boom"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: "parent-other-error",
        runId: RUN,
        artifactId: "perf",
        fields: ["round"],
      }),
    );
    await waitFor(() => expect(hook.result.current.error).toContain("boom"));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(1);
  });

  it("itemCount 抬升即带 afterSequence 增量续拉", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, false))
      .mockResolvedValueOnce(itemsPage(3, 1, false));
    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 2 } },
    );
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(workflowRunArtifactData).toHaveBeenCalledTimes(1);

    hook.rerender({ itemCount: 3 });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 2,
      limit: 200,
    });
  });

  it("本地一条都还没有时，itemCount 抬升照样拉——脚本顶部声明的看板就是这样长出第一个点的", async () => {
    // Regression: the old implementation had a "don't pull when items is empty" gate on the
    // incremental effect, so a board that is "declared first, then reported each round" stayed
    // empty forever (the full refetch on the first frame only retrieves zero items).
    workflowRunArtifactData
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce(itemsPage(1, 1, false));
    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 0 } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.items).toHaveLength(0);

    hook.rerender({ itemCount: 1 });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
  });

  it("拉取途中来的刷新信号不丢：收尾前补拉一轮", async () => {
    // Regression: if the request blocked by the single-flight gate were simply dropped, a run's
    // **final** report would never be drawn — no further itemCount change would come to trigger
    // the next fetch.
    let releaseFirst: (() => void) | undefined;
    workflowRunArtifactData.mockImplementationOnce(
      async () =>
        await new Promise<V4ConversationWorkflowRunArtifactDataResult>((resolve) => {
          releaseFirst = () => resolve(itemsPage(1, 1, false));
        }),
    );
    workflowRunArtifactData.mockResolvedValueOnce(itemsPage(2, 1, false));

    const hook = renderHook(
      (props: { itemCount: number }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "perf",
          itemCount: props.itemCount,
        }),
      { initialProps: { itemCount: 1 } },
    );
    await waitFor(() => expect(releaseFirst).toBeDefined());

    // Another report arrives before the first page returns: this one is blocked by the single-flight gate but must be remembered.
    hook.rerender({ itemCount: 2 });
    await act(async () => {
      releaseFirst?.();
    });

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "perf",
      afterSequence: 1,
      limit: 200,
    });
  });

  it("换产物先清空再整份重取：别的看板的点不留在这块画布上", async () => {
    workflowRunArtifactData
      .mockResolvedValueOnce(itemsPage(1, 2, false))
      .mockResolvedValueOnce(itemsPage(9, 1, false));
    const hook = renderHook(
      (props: { artifactId: string }) =>
        useWorkflowRunArtifactData({
          sessionId: SESSION,
          runId: RUN,
          artifactId: props.artifactId,
        }),
      { initialProps: { artifactId: "perf" } },
    );
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));

    hook.rerender({ artifactId: "other" });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    expect(hook.result.current.items[0]?.sequence).toBe(9);
    expect(workflowRunArtifactData).toHaveBeenLastCalledWith({
      sessionId: SESSION,
      runId: RUN,
      artifactId: "other",
      limit: 200,
    });
  });

  it("enabled 为 false（内容产物的 tab）时一次都不查", async () => {
    renderHook(() =>
      useWorkflowRunArtifactData({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "perf",
        enabled: false,
        itemCount: 5,
      }),
    );
    await act(async () => {});
    expect(workflowRunArtifactData).not.toHaveBeenCalled();
  });

  it("能力缺席抬起 unavailable，而不是报一个错给用户看", async () => {
    workflowRunArtifactData.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactData({ sessionId: SESSION, runId: RUN, artifactId: "perf" }),
    );
    await waitFor(() => expect(hook.result.current.unavailable).toBe(true));
    expect(hook.result.current.error).toBeNull();
  });
});

describe("useWorkflowRunArtifactBytes", () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    // jsdom has no object URLs: stub them to observe the invariant "revoke on version switch / unmount".
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (
      blob: Blob,
    ) => {
      const url = `blob:artifact-${created.length}-${blob.size}`;
      created.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (
      url: string,
    ) => {
      revoked.push(url);
    };
  });

  function chunk(
    text: string,
    nextOffset: number | null,
    totalBytes: number,
  ): V4ConversationWorkflowRunArtifactReadResult {
    return {
      dataBase64: encodeBytesToBase64(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>),
      mediaType: "text/markdown",
      totalBytes,
      nextOffset,
    };
  }

  it("按 nextOffset 分块读到底，拼成一份完整字节 + Blob + objectUrl", async () => {
    workflowRunArtifactRead
      .mockResolvedValueOnce(chunk("hello ", 6, 11))
      .mockResolvedValueOnce(chunk("world", null, 11));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );

    await waitFor(() => expect(hook.result.current.bytes).not.toBeNull());
    expect(new TextDecoder().decode(hook.result.current.bytes!)).toBe("hello world");
    expect(hook.result.current.mediaType).toBe("text/markdown");
    expect(hook.result.current.totalBytes).toBe(11);
    expect(hook.result.current.blob?.type).toBe("text/markdown");
    expect(hook.result.current.objectUrl).toBe(created[0]);
    // The second chunk's offset comes from the first chunk's nextOffset, and limit is the existing chunking bound from the attachment path.
    expect(workflowRunArtifactRead).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION,
      runId: RUN,
      artifactId: "notes",
      version: 1,
      offset: 6,
      limit: 512 * 1024,
    });
  });

  it("翻版本会 revoke 上一版的 objectUrl（否则每翻一版漏一份字节）", async () => {
    workflowRunArtifactRead
      .mockResolvedValueOnce(chunk("v1", null, 2))
      .mockResolvedValueOnce(chunk("v2 body", null, 7));
    const hook = renderHook(
      (props: { version: number }) =>
        useWorkflowRunArtifactBytes({
          sessionId: SESSION,
          runId: RUN,
          artifactId: "notes",
          version: props.version,
        }),
      { initialProps: { version: 1 } },
    );
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[0]));

    hook.rerender({ version: 2 });
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[1]));
    expect(revoked).toContain(created[0]);
  });

  it("卸载时 revoke", async () => {
    workflowRunArtifactRead.mockResolvedValueOnce(chunk("bye", null, 3));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.objectUrl).toBe(created[0]));

    hook.unmount();
    expect(revoked).toContain(created[0]);
  });

  it("预置看板（enabled 为 false）不读一个字节", async () => {
    renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "perf",
        version: 1,
        enabled: false,
      }),
    );
    await act(async () => {});
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });

  it("读失败落到 error，而不是留一个半截的 Blob", async () => {
    workflowRunArtifactRead.mockRejectedValueOnce(new Error("store gone"));
    const hook = renderHook(() =>
      useWorkflowRunArtifactBytes({
        sessionId: SESSION,
        runId: RUN,
        artifactId: "notes",
        version: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.error).toBe("store gone"));
    expect(hook.result.current.bytes).toBeNull();
    expect(hook.result.current.objectUrl).toBeNull();
  });
});
