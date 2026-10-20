// @vitest-environment jsdom

// Source of truth for the tool-card join fallback: the journal-backed discovery query
// (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Discovery queries" + "Retry semantics of the
// UI fallback").
//
// This hook exists because of an observed failure: the query used to be fired once and silently resolve to null on
// failure, and it happened to fire while the session was still cold (effect declaration order + the CLI's serial
// dispatch), so after a restart tool cards fell back to the compiled state forever. The cold-session prewarming was
// fixed on the CLI side; this pins the second half — the retryable hop actually retries.
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

const workflowRuns =
  vi.fn<(params: V4ConversationWorkflowRunsParams) => Promise<V4ConversationWorkflowRunsResult>>();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRuns }),
}));

// eslint-disable-next-line import/first -- The hook under test must be imported after the context mock.
import {
  isWorkflowRunsCapabilityMissing,
  useWorkflowRunJournalSummaries,
} from "@/hooks/useWorkflowRunJournalSummaries.js";

function result(runId: string): V4ConversationWorkflowRunsResult {
  return {
    runs: [{ runId, toolCallId: `call-${runId}`, status: "failed", resumable: true }],
  };
}

describe("isWorkflowRunsCapabilityMissing", () => {
  it("能力缺席与普通失败必须分开：前者终局，后者值得再问一次", () => {
    expect(
      isWorkflowRunsCapabilityMissing(
        new Error(
          "capability not supported by this session runtime: listDynamicWorkflowRuns (session s1)",
        ),
      ),
    ).toBe(true);
    expect(isWorkflowRunsCapabilityMissing(new Error("fault.command.capabilityUnsupported"))).toBe(
      true,
    );
    expect(
      isWorkflowRunsCapabilityMissing(new Error("fault.workflowRuns.sessionNotFound: s1")),
    ).toBe(false);
    expect(isWorkflowRunsCapabilityMissing(new Error("socket closed"))).toBe(false);
  });
});

describe("useWorkflowRunJournalSummaries", () => {
  it("首查成功即收口：live 抬升不再多打一次 RPC", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);

    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("冷开首查失败 → live 抬升时重试并补上摘要（这就是那个失效的修复）", async () => {
    workflowRuns.mockReset();
    workflowRuns
      // The session is not registered yet: the CLI side returns a structured sessionNotFound.
      .mockRejectedValueOnce(new Error("fault.workflowRuns.sessionNotFound: sess-1"))
      .mockResolvedValueOnce(result("dwfrun-1"));
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    expect(hook.result.current).toBeNull();

    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1");
  });

  it("能力缺席不重试：旧 CLI / journal 不可用是稳定事实", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockRejectedValue(
      new Error(
        "capability not supported by this session runtime: listDynamicWorkflowRuns (session sess-1)",
      ),
    );
    const hook = renderHook(
      (props: { live: boolean }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: props.live }),
      { initialProps: { live: false } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    hook.rerender({ live: true });
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("没有 sessionId（草稿会话）时根本不发请求", async () => {
    workflowRuns.mockReset();
    const hook = renderHook(() => useWorkflowRunJournalSummaries({ sessionId: null, live: true }));
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).not.toHaveBeenCalled();
  });

  it("enabled=false（嵌套只读 transcript）不发请求：journal 按父会话建键，拿 actor id 去问只会造出幽灵 runtime", async () => {
    // Bug root cause (observed 2026-08-24): the actor transcript's nested SessionPane used to send this query with
    // the actor session id, and the CLI's cold-session prewarming then materialized a second runtime for a
    // **running** detached session, freezing the live view at "worked for xx seconds". The CLI side was closed off
    // via hasLiveConversation; this pins the UI-side half: read-only nested panes (actor / subagent transcript)
    // must never issue this parent-session-only query.
    workflowRuns.mockReset();
    const hook = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-actor-1", live: true, enabled: false }),
    );
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).not.toHaveBeenCalled();
  });

  it("换会话：丢弃旧摘要并重查——上一个会话的 run 绝不能给新会话的卡片做 join", async () => {
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"));
    const hook = renderHook(
      (props: { sessionId: string }) =>
        useWorkflowRunJournalSummaries({ sessionId: props.sessionId, live: true }),
      { initialProps: { sessionId: "sess-1" } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));

    hook.rerender({ sessionId: "sess-2" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));
    expect(workflowRuns).toHaveBeenCalledTimes(2);
  });

  it("切回一个问过的会话：重查一次而不是空着（收口记的是会话 + 答案，不是一个裸的「问过了」）", async () => {
    // The close-out records only the **most recent** session and its answer: if we recorded just an id while leaving
    // the answer in state, switching back would fail both ways — the early return skips requerying, and switching
    // sessions clears the state, so the card would never get an entry point. Requerying one journal page is cheap;
    // a missing entry point is not.
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"))
      .mockResolvedValueOnce(result("dwfrun-1"));
    const hook = renderHook(
      (props: { sessionId: string }) =>
        useWorkflowRunJournalSummaries({ sessionId: props.sessionId, live: true }),
      { initialProps: { sessionId: "sess-1" } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));
    hook.rerender({ sessionId: "sess-2" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));

    hook.rerender({ sessionId: "sess-1" });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));
    expect(workflowRuns).toHaveBeenCalledTimes(3);
  });

  // ── refreshKey: the freshness source for the run catalog page and the task island count ──
  // Summaries change mid-session too (finishing a run adds one more ended run), yet the close-out semantics must
  // block pointless requeries. `refreshKey` is that seam: the caller supplies "a monotonic count of settled runs",
  // raised once per finished run.

  it("refreshKey 不变：仍然只查一次（渲染再多也不多打 RPC）", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 2 } },
    );

    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    hook.rerender({ refreshKey: 2 });
    hook.rerender({ refreshKey: 2 });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("refreshKey 抬升：恰好重取一次并换上新摘要（会话中途跑完一个 run）", async () => {
    workflowRuns.mockReset();
    workflowRuns
      .mockResolvedValueOnce(result("dwfrun-1"))
      .mockResolvedValueOnce(result("dwfrun-2"));
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-1"));

    hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(hook.result.current?.[0]?.runId).toBe("dwfrun-2"));
    expect(workflowRuns).toHaveBeenCalledTimes(2);
  });

  it("能力缺席在 refreshKey 抬升后**仍然**不重探：那是稳定事实，不是新鲜度问题", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockRejectedValue(
      new Error(
        "capability not supported by this session runtime: listDynamicWorkflowRuns (session sess-1)",
      ),
    );
    const hook = renderHook(
      (props: { refreshKey: number }) =>
        useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, ...props }),
      { initialProps: { refreshKey: 0 } },
    );

    await waitFor(() => expect(workflowRuns).toHaveBeenCalledTimes(1));
    hook.rerender({ refreshKey: 1 });
    hook.rerender({ refreshKey: 2 });
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(workflowRuns).toHaveBeenCalledTimes(1);
  });

  it("limit 原样传给查询；缺省时不带这个键（由 CLI 侧定缺省）", async () => {
    workflowRuns.mockReset();
    workflowRuns.mockResolvedValue(result("dwfrun-1"));
    const withLimit = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-1", live: true, limit: 64 }),
    );
    await waitFor(() => expect(withLimit.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenLastCalledWith({ sessionId: "sess-1", limit: 64 });

    const withoutLimit = renderHook(() =>
      useWorkflowRunJournalSummaries({ sessionId: "sess-2", live: true }),
    );
    await waitFor(() => expect(withoutLimit.result.current).toHaveLength(1));
    expect(workflowRuns).toHaveBeenLastCalledWith({ sessionId: "sess-2" });
  });
});
