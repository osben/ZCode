// L2: permission / background command group (resolveInteraction / cancelBackgroundWork) + broker
// race wiring. The L2 layer as defined by 08-phasing M4:
// - resolveInteraction happy path (registry hit delivers the answer) + late-arrival idempotency
//   (a miss does not throw);
// - cancelBackgroundWork happy path (drives the optional core capability directly) + structured
//   error when the capability is unsupported;
// - broker race: the v4 answer arriving first cancels the dangling reverse RPC and returns the
//   mapped result; the RPC arriving first unregisters the entry;
//   permission's allowAlways mapping must carry permissionUpdates (the persisted rule is not lost).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  WORKFLOW_ARTIFACT_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_WORKSPACE_LIMITS,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunSessionSummary,
  SessionEvent,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { V4CapabilityUnsupportedError } from "../src/zcode-protocol-v4/commands/handlers/interaction-background.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import { createProtocolInteractionBroker } from "../src/zcode-protocol/interaction-broker.js";
import { PERMISSION_DENIED_BY_USER_CONTENT } from "../src/permission-options.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

function makeHost(overrides: Partial<V4CommandCoreHost> = {}): V4CommandCoreHost {
  return {
    getRecord: () => undefined,
    ...overrides,
  };
}

/**
 * A minimal raw event sufficient for the gateway to register a session as detached live
 * (the live channel of a dwf actor / subagent: the real runtime lives elsewhere, the host has no
 * record).
 */
function detachedLiveEvent(sessionId: string): SessionEvent {
  return {
    id: "event-detached-1",
    sessionId,
    type: SessionEventType.SessionCreated,
    timestamp: new Date(0),
    traceId: "trace-detached",
    sequenceNumber: 1,
    payload: { mode: "default", contextWindow: 200_000 },
  } as unknown as SessionEvent;
}

describe("v4 原生 resolveInteraction", () => {
  it("正路径：登记表命中，应答投递给等待中的 deferred", async () => {
    const registry = new V4InteractionRegistry();
    const resolve = vi.fn();
    registry.register("perm_1", resolve);
    const host = makeHost({ interactions: registry });

    await new V4CommandExecutor(host).execute(
      envelope("resolveInteraction", {
        interactionId: "perm_1",
        answer: { optionId: "allowOnce" },
      }),
    );

    expect(resolve).toHaveBeenCalledWith({ optionId: "allowOnce" });
    // Removed as soon as it is delivered: a second answer for the same id is treated as a miss.
    expect(registry.has("perm_1")).toBe(false);
  });

  it("晚到幂等：未命中（已应答/未知 id）不抛错，静默成功收口", async () => {
    const host = makeHost({ interactions: new V4InteractionRegistry() });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("resolveInteraction", {
          interactionId: "perm_gone",
          answer: { optionId: "deny" },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("registry 未注入（测试夹具形态）：同样按未命中幂等收口", async () => {
    await expect(
      new V4CommandExecutor(makeHost()).execute(
        envelope("resolveInteraction", {
          interactionId: "perm_x",
          answer: {},
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("snoozeInteractionAutoResolution 通过同一 registry 幂等暂停", async () => {
    const registry = new V4InteractionRegistry();
    const updates = vi.fn();
    const unregister = registry.register("ask-snooze", vi.fn(), {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: updates,
    });
    const host = makeHost({ interactions: registry });

    await new V4CommandExecutor(host).execute(
      envelope("snoozeInteractionAutoResolution", {
        interactionId: "ask-snooze",
      }),
    );
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("snoozeInteractionAutoResolution", {
          interactionId: "ask-snooze",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ state: "snoozed" }));
    unregister();
  });
});

describe("V4InteractionRegistry", () => {
  it("注销函数幂等清理；重注册覆盖旧回调（reannounce 指向最新等待）", () => {
    const registry = new V4InteractionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registry.register("i1", first);
    registry.register("i1", second);

    expect(registry.resolve("i1", { optionId: "deny" })).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ optionId: "deny" });

    // A stale unregister function arriving late has no effect (the entry was already removed by
    // resolve).
    unregisterFirst();
    expect(registry.resolve("i1", { optionId: "deny" })).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only starts the five-minute window for the head interaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const permissionResolve = vi.fn();
    const askResolve = vi.fn();
    const updates = vi.fn();

    registry.register("permission-first", permissionResolve, {
      kind: "other",
      sessionId: "s1",
    });
    registry.register("ask-second", askResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: updates,
    });

    expect(updates).not.toHaveBeenCalled();
    registry.resolve("permission-first", { optionId: "allowOnce" });
    expect(updates).toHaveBeenLastCalledWith({
      state: "hiddenGrace",
      startedAt: Date.parse("2026-07-13T00:00:00.000Z"),
      visibleAt: Date.parse("2026-07-13T00:01:00.000Z"),
      deadlineAt: Date.parse("2026-07-13T00:05:00.000Z"),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates).toHaveBeenLastCalledWith({
      state: "visibleCountdown",
      startedAt: Date.parse("2026-07-13T00:00:00.000Z"),
      visibleAt: Date.parse("2026-07-13T00:01:00.000Z"),
      deadlineAt: Date.parse("2026-07-13T00:05:00.000Z"),
    });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(askResolve).toHaveBeenCalledOnce();
    expect(askResolve).toHaveBeenCalledWith({
      action: "accept",
      content: { answers: {} },
    });
  });

  it("permanently snoozes the active ask interaction and treats repeats as noop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const resolve = vi.fn();
    const updates = vi.fn();
    registry.register("ask", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: updates,
    });

    await vi.advanceTimersByTimeAsync(299_000);
    await expect(registry.snoozeAutoResolution("ask")).resolves.toBe(true);
    await expect(registry.snoozeAutoResolution("ask")).resolves.toBe(false);
    expect(updates).toHaveBeenLastCalledWith({
      state: "snoozed",
      startedAt: Date.parse("2026-07-13T00:00:00.000Z"),
      snoozedAt: Date.parse("2026-07-13T00:04:59.000Z"),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolve).not.toHaveBeenCalled();
    expect(registry.has("ask")).toBe(true);
  });

  it("re-registers against the original absolute deadline instead of restarting five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const firstResolve = vi.fn();
    registry.register("ask-restore", firstResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });
    await vi.advanceTimersByTimeAsync(180_000);

    const restoredResolve = vi.fn();
    registry.register("ask-restore", restoredResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(restoredResolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(firstResolve).not.toHaveBeenCalled();
    expect(restoredResolve).toHaveBeenCalledWith({
      action: "accept",
      content: { answers: {} },
    });
  });

  it("restores a persisted snooze without recreating a deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:04:00.000Z"));
    const registry = new V4InteractionRegistry();
    const resolve = vi.fn();
    const updates = vi.fn();
    registry.register("ask-snoozed-restore", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      initialAutoResolution: {
        state: "snoozed",
        startedAt: Date.parse("2026-07-13T00:00:00.000Z"),
        snoozedAt: Date.parse("2026-07-13T00:00:30.000Z"),
      },
      onAutoResolutionUpdated: updates,
    });

    expect(updates).toHaveBeenCalledWith(expect.objectContaining({ state: "snoozed" }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("gives each queued AskUserQuestion a full window only after it reaches the head", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const secondUpdates = vi.fn();
    registry.register("ask-first", firstResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });
    registry.register("ask-second", secondResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: secondUpdates,
    });

    await vi.advanceTimersByTimeAsync(299_000);
    expect(secondUpdates).not.toHaveBeenCalled();
    registry.resolve("ask-first", {
      action: "accept",
      content: { answers: { q: "a" } },
    });
    expect(secondUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "hiddenGrace",
        startedAt: Date.parse("2026-07-13T00:04:59.000Z"),
        deadlineAt: Date.parse("2026-07-13T00:09:59.000Z"),
      }),
    );

    await vi.advanceTimersByTimeAsync(299_999);
    expect(secondResolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(secondResolve).toHaveBeenCalledWith({
      action: "accept",
      content: { answers: {} },
    });
  });

  it("clears auto-resolution timers when the owning turn unregisters", async () => {
    vi.useFakeTimers();
    const registry = new V4InteractionRegistry();
    const resolve = vi.fn();
    const unregister = registry.register("ask-stopped", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });

    unregister();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(resolve).not.toHaveBeenCalled();
    expect(registry.has("ask-stopped")).toBe(false);
  });

  it("keeps newly registered AskUserQuestion pending while auto-resolution is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const askResolve = vi.fn();
    const askUpdates = vi.fn();
    const permissionResolve = vi.fn();

    await expect(registry.setAskUserQuestionAutoResolutionEnabled(false)).resolves.toBe(0);
    registry.register("ask-disabled", askResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: askUpdates,
    });
    registry.register("permission", permissionResolve, {
      kind: "other",
      sessionId: "s2",
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(askResolve).not.toHaveBeenCalled();
    expect(askUpdates).not.toHaveBeenCalled();
    expect(registry.has("ask-disabled")).toBe(true);
    expect(registry.resolve("permission", { optionId: "allowOnce" })).toBe(true);
    expect(permissionResolve).toHaveBeenCalledWith({ optionId: "allowOnce" });
  });

  it("supports an injected runtime clock window for desktop GUI candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry({
      hiddenGraceMs: 10,
      autoResolutionMs: 50,
    });
    const resolve = vi.fn();
    registry.register("ask-fast-clock", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not let a stale session startup preference override an explicit setting command", async () => {
    vi.useFakeTimers();
    const registry = new V4InteractionRegistry();
    await registry.setAskUserQuestionAutoResolutionEnabled(false);
    await registry.initializeAskUserQuestionAutoResolutionEnabled(true);
    const resolve = vi.fn();
    registry.register("ask-after-stale-startup", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("disabling snoozes the active AskUserQuestion and permanently disqualifies queued ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const firstResolve = vi.fn();
    const firstUpdates = vi.fn().mockResolvedValue(undefined);
    const secondResolve = vi.fn();
    const secondUpdates = vi.fn().mockResolvedValue(undefined);
    const otherSessionResolve = vi.fn();
    const otherSessionUpdates = vi.fn().mockResolvedValue(undefined);

    registry.register("ask-first", firstResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: firstUpdates,
    });
    registry.register("ask-second", secondResolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: secondUpdates,
    });
    registry.register("ask-other-session", otherSessionResolve, {
      kind: "askUserQuestion",
      sessionId: "s3",
      onAutoResolutionUpdated: otherSessionUpdates,
    });
    await vi.advanceTimersByTimeAsync(59_000);

    await expect(registry.setAskUserQuestionAutoResolutionEnabled(false)).resolves.toBe(2);
    expect(firstUpdates).toHaveBeenLastCalledWith({
      state: "snoozed",
      startedAt: Date.parse("2026-07-13T00:00:00.000Z"),
      snoozedAt: Date.parse("2026-07-13T00:00:59.000Z"),
    });
    expect(otherSessionUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "snoozed",
        snoozedAt: Date.parse("2026-07-13T00:00:59.000Z"),
      }),
    );

    await expect(registry.setAskUserQuestionAutoResolutionEnabled(false)).resolves.toBe(0);
    await expect(registry.setAskUserQuestionAutoResolutionEnabled(true)).resolves.toBe(0);
    registry.resolve("ask-first", {
      action: "accept",
      content: { answers: { first: "answered" } },
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(secondUpdates).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();
    expect(otherSessionResolve).not.toHaveBeenCalled();

    const newResolve = vi.fn();
    registry.register("ask-new", newResolve, {
      kind: "askUserQuestion",
      sessionId: "s2",
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(newResolve).toHaveBeenCalledWith({
      action: "accept",
      content: { answers: {} },
    });
  });

  it("disabling at the last second wins before the deadline callback and awaits persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const registry = new V4InteractionRegistry();
    const resolve = vi.fn();
    let releasePersistence: (() => void) | undefined;
    const persisted = new Promise<void>((resolvePersistence) => {
      releasePersistence = resolvePersistence;
    });
    const updates = vi.fn(() => persisted);

    registry.register("ask-last-second", resolve, {
      kind: "askUserQuestion",
      sessionId: "s1",
      onAutoResolutionUpdated: updates,
    });
    await vi.advanceTimersByTimeAsync(299_999);

    let acknowledged = false;
    const disabling = registry.setAskUserQuestionAutoResolutionEnabled(false).then((count) => {
      acknowledged = true;
      return count;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    releasePersistence?.();
    await expect(disabling).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(registry.has("ask-last-second")).toBe(true);
  });
});

describe("v4 原生 Workspace Hook review commands", () => {
  const target = {
    sessionId: "s1",
    workspaceIdentity: "workspace:1",
    bundleDigest: "a".repeat(64),
    reviewFlowId: "flow-1",
    generation: 1,
    interactionId: "interaction-1",
  };

  function record(app: Record<string, unknown>): V4SessionRecordView {
    return {
      app: { sessionId: "s1", ...app },
      traceContext: {} as never,
      workspace: { workspacePath: "/w" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView;
  }

  it("三条命令只调用 record.app 的受限 Workspace Hook API", async () => {
    const respondWorkspaceHookReview = vi
      .fn()
      .mockResolvedValue({ accepted: true, reviewItemIds: ["item-1"] });
    const toggleWorkspaceHookReviewItem = vi
      .fn()
      .mockResolvedValue({ accepted: true, reviewItemIds: ["item-1"] });
    const revokeWorkspaceHookTrust = vi
      .fn()
      .mockResolvedValue({ accepted: true, reviewItemIds: ["item-1"] });
    const value = record({
      respondWorkspaceHookReview,
      toggleWorkspaceHookReviewItem,
      revokeWorkspaceHookTrust,
    });
    const executor = new V4CommandExecutor(makeHost({ getRecord: () => value }));

    await executor.execute(
      envelope("respondWorkspaceHookReview", {
        ...target,
        decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
      }),
    );
    await executor.execute(
      envelope("toggleWorkspaceHookReviewItem", {
        ...target,
        reviewItemId: "item-1",
        enabled: false,
      }),
    );
    await executor.execute(
      envelope("revokeWorkspaceHookTrust", {
        ...target,
        reviewItemIds: ["item-1"],
      }),
    );
    await executor.execute(
      envelope("revokeWorkspaceHookTrust", {
        sessionId: "s1",
        workspaceIdentity: "workspace:1",
        bundleDigest: "a".repeat(64),
        hookDeclarationDigests: ["b".repeat(64)],
      }),
    );

    expect(respondWorkspaceHookReview).toHaveBeenCalledWith({
      ...target,
      decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
    });
    expect(toggleWorkspaceHookReviewItem).toHaveBeenCalledWith({
      ...target,
      reviewItemId: "item-1",
      enabled: false,
    });
    expect(revokeWorkspaceHookTrust).toHaveBeenCalledWith({
      ...target,
      reviewItemIds: ["item-1"],
    });
    expect(revokeWorkspaceHookTrust).toHaveBeenCalledWith({
      sessionId: "s1",
      workspaceIdentity: "workspace:1",
      bundleDigest: "a".repeat(64),
      hookDeclarationDigests: ["b".repeat(64)],
    });
  });

  it("payload/envelope session mismatch 与 Runtime rejection 都保留稳定 reasonCode", async () => {
    const value = record({
      respondWorkspaceHookReview: vi.fn().mockResolvedValue({
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      }),
    });
    const executor = new V4CommandExecutor(makeHost({ getRecord: () => value }));

    await expect(
      executor.execute(
        envelope("respondWorkspaceHookReview", {
          ...target,
          sessionId: "other",
          decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
        }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    await expect(
      executor.execute(
        envelope("respondWorkspaceHookReview", {
          ...target,
          decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
        }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "workspace_hooks_review_superseded",
    });
  });

  it("requestWorkspaceHookReview 调用 record.app.requestWorkspaceHookReview", async () => {
    const requestWorkspaceHookReview = vi
      .fn()
      .mockResolvedValue({ accepted: true, reviewItemIds: [] });
    const value = record({ requestWorkspaceHookReview });
    const executor = new V4CommandExecutor(makeHost({ getRecord: () => value }));

    await executor.execute(
      envelope("requestWorkspaceHookReview", {
        sessionId: "s1",
        workspaceIdentity: "workspace:1",
        bundleDigest: "a".repeat(64),
      }),
    );

    expect(requestWorkspaceHookReview).toHaveBeenCalledWith({
      workspaceIdentity: "workspace:1",
      bundleDigest: "a".repeat(64),
    });
  });

  it("requestWorkspaceHookReview rejection 保留稳定 reasonCode", async () => {
    const value = record({
      requestWorkspaceHookReview: vi.fn().mockResolvedValue({
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      }),
    });
    const executor = new V4CommandExecutor(makeHost({ getRecord: () => value }));

    await expect(
      executor.execute(
        envelope("requestWorkspaceHookReview", {
          sessionId: "s1",
          workspaceIdentity: "workspace:1",
          bundleDigest: "a".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
  });

  it("requestWorkspaceHookReview 在 payload/envelope session 不一致时拒绝", async () => {
    const requestWorkspaceHookReview = vi
      .fn()
      .mockResolvedValue({ accepted: true, reviewItemIds: [] });
    const value = record({ requestWorkspaceHookReview });
    const executor = new V4CommandExecutor(makeHost({ getRecord: () => value }));

    await expect(
      executor.execute(
        envelope("requestWorkspaceHookReview", {
          sessionId: "other",
          workspaceIdentity: "workspace:1",
          bundleDigest: "a".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(requestWorkspaceHookReview).not.toHaveBeenCalled();
  });
});

describe("v4 原生 cancelBackgroundWork", () => {
  function makeRecord(app: Record<string, unknown>): V4SessionRecordView {
    return {
      app,
      workspace: { workspacePath: "/w" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView;
  }

  it("正路径：workId ≡ taskId 直传 core（经 app 调用保 this 绑定）", async () => {
    const cancelBackgroundTask = vi.fn().mockResolvedValue(undefined);
    const record = makeRecord({ sessionId: "s1", cancelBackgroundTask });
    const host = makeHost({
      getRecord: (id) => (id === "s1" ? record : undefined),
    });

    await new V4CommandExecutor(host).execute(
      envelope("cancelBackgroundWork", { workId: "task-9" }),
    );
    expect(cancelBackgroundTask).toHaveBeenCalledWith("task-9");
  });

  it("能力不支持：runtime 无 cancelBackgroundTask → 结构化 reasonCode 错误", async () => {
    const record = makeRecord({ sessionId: "s1" });
    const host = makeHost({
      getRecord: (id) => (id === "s1" ? record : undefined),
    });

    const run = new V4CommandExecutor(host).execute(
      envelope("cancelBackgroundWork", { workId: "task-9" }),
    );
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  // Fix rationale (2026-09-15): when core replied "nothing was cancelled", the old handler still
  // accepted, so the UI button appeared to do nothing.
  it.each([
    ["background_task_not_found", "not_found"],
    ["background_task_not_running", "not_running"],
    ["background_task_cancel_not_supported", "cancel_not_supported"],
  ])(
    "core 回 reason %s → fault.command.backgroundWorkCancelRejected.%s",
    async (reason, suffix) => {
      const cancelBackgroundTask = vi
        .fn()
        .mockResolvedValue({ cancelled: false, reason, status: "lost", taskId: "dwfrun-stale" });
      const record = makeRecord({ sessionId: "s1", cancelBackgroundTask });
      const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

      const run = new V4CommandExecutor(host).execute(
        envelope("cancelBackgroundWork", { workId: "dwfrun-stale" }),
      );
      await expect(run).rejects.toMatchObject({
        reasonCode: `fault.command.backgroundWorkCancelRejected.${suffix}`,
      });
    },
  );

  it("真取消了（无 reason）→ accepted", async () => {
    const cancelBackgroundTask = vi
      .fn()
      .mockResolvedValue({ cancelled: true, status: "cancelled", taskId: "task-9" });
    const record = makeRecord({ sessionId: "s1", cancelBackgroundTask });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    await expect(
      new V4CommandExecutor(host).execute(envelope("cancelBackgroundWork", { workId: "task-9" })),
    ).resolves.toBeUndefined();
  });

  // Cancellation has exactly one path (the spec's Invariants): the detail page button and the
  // backgroundWorks panel both send this command; there is no second cancel RPC. This walks the
  // whole chain with a **real** AgentRuntime and proves workId reaches
  // DynamicWorkflowRunPort.cancel directly without any identity mapping table
  // (workId ≡ taskId ≡ runId).
  it("dwf run：workId 一路打到 DynamicWorkflowRunPort.cancel", async () => {
    const { AgentRuntime, InMemoryRuntimeTaskRegistry } = await import("@zcode/core");
    const { createSessionId } = await import("@zcode/contracts");
    const { createInMemorySessionEventStore } = await import("@zcode/adapters/storage");

    const cancelled: string[] = [];
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "dwfrun-v4",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-v4",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = new AgentRuntime(createSessionId("v4-dwf-cancel"), { mode: "build" }, {
      dynamicWorkflowRunPort: {
        async submit() {
          throw new Error("submit should not be called");
        },
        async getTask(taskId: string) {
          return {
            taskId,
            runId: taskId,
            startedAt: new Date(0),
            status: cancelled.includes(taskId) ? "cancelled" : "running",
          };
        },
        async waitForTask(taskId: string) {
          return { taskId, runId: taskId, startedAt: new Date(0), status: "cancelled" };
        },
        async cancel(runId: string) {
          cancelled.push(runId);
          return true;
        },
        async listEvents() {
          return [];
        },
      },
      eventStore: createInMemorySessionEventStore(),
      runtimeTaskRegistry,
    } as never);

    const record = makeRecord({
      sessionId: "s1",
      cancelBackgroundTask: (taskId: string) => runtime.cancelBackgroundTask(taskId),
    });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    await new V4CommandExecutor(host).execute(
      envelope("cancelBackgroundWork", { workId: "dwfrun-v4" }),
    );

    expect(cancelled).toEqual(["dwfrun-v4"]);
  });
});

// ── broker race wiring (interaction-broker × V4InteractionRegistry) ──────────────

/** Fake requestClient: hangs until signal abort (simulating a dangling reverse RPC), or answers per script. */
function makeBrokerContext(options?: {
  respond?: (method: string) => Promise<unknown>;
  sessionEntries?: () => Promise<unknown[]>;
}) {
  const registry = new V4InteractionRegistry();
  const requestClient = vi.fn(
    (method: string, _params: unknown, _schema: unknown, reqOptions?: { signal?: AbortSignal }) => {
      if (options?.respond) {
        return options.respond(method);
      }
      return new Promise((_resolve, reject) => {
        reqOptions?.signal?.addEventListener("abort", () =>
          reject(new Error("client request aborted")),
        );
      });
    },
  );
  const context = {
    deps: {
      sessionStore: options?.sessionEntries
        ? { sessionEntries: options.sessionEntries }
        : undefined,
    },
    requestClient,
    v4Interactions: registry,
  } as unknown as ZCodeProtocolAgentServerContext;
  return {
    broker: createProtocolInteractionBroker(context),
    registry,
    requestClient,
  };
}

function permissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "perm_race",
    sessionId: "s1",
    traceId: "t1",
    toolCallId: "tc1",
    toolName: "Bash",
    input: { command: "ls" },
    mode: "default",
    ruleId: "r1",
    reason: "approval needed",
    riskLevel: "medium",
    requestedAt: new Date(),
    ...overrides,
    // Structurally aligned with @zcode/contracts PermissionBrokerRequest (branded-type fields use
    // loose assertions).
  } as never;
}

describe("broker × v4 竞速", () => {
  it("v4 allowOnce 先到：取消悬空 RPC，映射为 allow", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    // Wait for the broker to finish registering (requestClient having been called means it is
    // registered).
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.has("perm_race")).toBe(true);
    registry.resolve("perm_race", { optionId: "allowOnce" });

    const result = await pending;
    expect(result.decision).toBe("allow");
    // finally has unregistered: the registry is clean.
    expect(registry.has("perm_race")).toBe(false);
  });

  it("v4 allowAlways 先到：携带 permissionUpdates（持久化规则不丢）", async () => {
    const { broker, registry } = makeBrokerContext();
    const suggestedPermissionUpdates = [
      {
        behavior: "allow",
        rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
        type: "addRules",
      },
    ];
    const pending = broker.requestPermission(permissionRequest({ suggestedPermissionUpdates }));
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", {
      optionId: "allowAlways",
      freeText: "这段文字不应改变项目级 allow",
    });
    const result = await pending;
    expect(result.decision).toBe("allow");
    expect(result.permissionUpdates).toEqual(suggestedPermissionUpdates);
  });

  it("v4 deny/未知 optionId 先到：落 deny（权限语义宁拒勿放）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", { optionId: "mystery" });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: PERMISSION_DENIED_BY_USER_CONTENT,
    });
  });

  it("v4 deny/未知 optionId 携带反馈：仍落 deny 并保留反馈", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", { optionId: "mystery", freeText: "请先说明只读替代方案" });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      preserveReasonFormatting: true,
      reason:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. To tell you how to proceed, the user said:\n请先说明只读替代方案",
    });
  });

  it("v4 缺少 optionId 携带反馈：仍 fail-closed 为 deny", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", { freeText: "请先说明只读替代方案" });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. To tell you how to proceed, the user said:\n请先说明只读替代方案",
    });
  });

  it("v4 deny 携带反馈：反馈进入同一个拒绝 tool_result 文案", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", {
      optionId: "deny",
      freeText: "请先说明只读替代方案",
    });

    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      preserveReasonFormatting: true,
      reason:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. To tell you how to proceed, the user said:\n请先说明只读替代方案",
    });
  });

  it("v4 deny 空白反馈：回退稳定拒绝文案", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", { optionId: "deny", freeText: "  \n\t" });

    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    });
  });

  it("v4 allow 携带反馈：保持 allow response，不把反馈误作 deny", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(permissionRequest());
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("perm_race", {
      optionId: "allowOnce",
      freeText: "这段文字不应改变 allow",
    });

    await expect(pending).resolves.toMatchObject({
      decision: "allow",
      reason: "Approved once",
    });
  });

  it("legacy RPC 先到：v4 登记在 finally 注销（晚到 v4 应答按未命中幂等）", async () => {
    const { broker, registry } = makeBrokerContext({
      respond: async () => ({ decision: "allow" }),
    });
    const result = await broker.requestPermission(permissionRequest());
    expect(result.decision).toBe("allow");
    expect(registry.has("perm_race")).toBe(false);
    expect(registry.resolve("perm_race", { optionId: "deny" })).toBe(false);
  });

  it("legacy RPC Deny 缺少 reason 时使用稳定拒绝文案", async () => {
    const { broker } = makeBrokerContext({
      respond: async () => ({ decision: "deny" }),
    });

    await expect(broker.requestPermission(permissionRequest())).resolves.toMatchObject({
      decision: "deny",
      reason:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    });
  });

  it("外层 signal 取消：原样抛出（不误吞为 v4 应答）", async () => {
    const { broker } = makeBrokerContext();
    const outer = new AbortController();
    const pending = broker.requestPermission(permissionRequest(), {
      signal: outer.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    outer.abort();
    await expect(pending).rejects.toThrow("client request aborted");
  });

  it("AskUserQuestion：v4 freeText 先到 → accept 落单题 answer 槽位", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "ask_race",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "口味",
              question: "要哪种？",
              multiSelect: false,
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("ask_race", { freeText: "B 口味" });
    const result = await pending;
    // accept + content.answer → decision=modify, with the answer merged into
    // modifiedInput.answers.
    expect(result.decision).toBe("modify");
    expect(result.modifiedInput).toMatchObject({
      answers: { "要哪种？": "B 口味" },
    });
  });

  it("AskUserQuestion：五分钟无操作自动提交空 answers 并继续", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    try {
      const { broker } = makeBrokerContext();
      const pending = broker.requestPermission(
        permissionRequest({
          requestId: "ask_timeout",
          toolName: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "口味",
                question: "要哪种？",
                multiSelect: false,
                options: [
                  { label: "A", description: "a" },
                  { label: "B", description: "b" },
                ],
              },
            ],
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(300_000);

      await expect(pending).resolves.toMatchObject({
        decision: "modify",
        modifiedInput: { answers: {} },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("AskUserQuestion：进程恢复沿用持久化绝对 deadline，不重新获得五分钟", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-13T00:00:00.000Z");
    vi.setSystemTime(new Date(startedAt + 180_000));
    try {
      const { broker, registry } = makeBrokerContext({
        sessionEntries: async () => [
          {
            id: "user-input-auto-resolution:ask-restored",
            sessionID: "s1",
            type: "runtime/user_input_auto_resolution",
            time: { created: startedAt, updated: startedAt + 60_000 },
            data: {
              interactionId: "ask-restored",
              toolCallId: "tc1",
              autoResolution: {
                state: "visibleCountdown",
                startedAt,
                visibleAt: startedAt + 60_000,
                deadlineAt: startedAt + 300_000,
              },
            },
          },
        ],
      });
      const pending = broker.requestPermission(
        permissionRequest({
          requestId: "ask-restored",
          toolName: "AskUserQuestion",
          input: {
            questions: [
              {
                header: "口味",
                question: "要哪种？",
                multiSelect: false,
                options: [
                  { label: "A", description: "a" },
                  { label: "B", description: "b" },
                ],
              },
            ],
          },
        }),
      );
      for (let attempt = 0; attempt < 20 && !registry.has("ask-restored"); attempt += 1) {
        await Promise.resolve();
      }
      expect(registry.has("ask-restored")).toBe(true);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(registry.has("ask-restored")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        decision: "modify",
        modifiedInput: { answers: {} },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("AskUserQuestion：v4 action/content 先到 → 多题答案无损直传（M5 ③-2 additive）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "ask_multi",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "口味",
              question: "要哪种？",
              multiSelect: false,
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
            {
              header: "数量",
              question: "要几份？",
              multiSelect: false,
              options: [
                { label: "1", description: "one" },
                { label: "2", description: "two" },
              ],
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // host adapter respondElicitation converging path: action=accept + content.answers passes
    // multi-question answers through directly.
    registry.resolve("ask_multi", {
      action: "accept",
      content: { answers: { "要哪种？": "B", "要几份？": "2" } },
    });
    const result = await pending;
    expect(result.decision).toBe("modify");
    expect(result.modifiedInput).toMatchObject({
      answers: { "要哪种？": "B", "要几份？": "2" },
    });
  });

  it("AskUserQuestion：丢弃旧客户端提交的 blank 答案", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "ask_partial_blank",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "口味",
              question: "要哪种？",
              multiSelect: false,
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
            {
              header: "数量",
              question: "要几份？",
              multiSelect: false,
              options: [
                { label: "1", description: "one" },
                { label: "2", description: "two" },
              ],
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("ask_partial_blank", {
      action: "accept",
      content: { answers: { "要哪种？": " B ", "要几份？": "   " } },
    });
    await expect(pending).resolves.toMatchObject({
      decision: "modify",
      modifiedInput: { answers: { "要哪种？": "B" } },
    });
  });

  it("AskUserQuestion：v4 action=decline 先到 → 拒绝（不再回落 optionId 路径）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "ask_decline",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "口味",
              question: "要哪种？",
              multiSelect: false,
              options: [{ label: "A", description: "a" }],
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("ask_decline", { action: "decline" });
    await expect(pending).resolves.toMatchObject({ decision: "deny" });
  });

  it("ExitPlanMode：v4 action=accept + content.answer=approve → 批准（allow）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({ requestId: "plan_action", toolName: "ExitPlanMode" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("plan_action", {
      action: "accept",
      content: { answer: "approve" },
    });
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
  });

  it("ExitPlanMode：v4 action=accept + content 反馈 → 计划反馈（deny + plan_approval_feedback）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "plan_action_fb",
        toolName: "ExitPlanMode",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("plan_action_fb", {
      action: "accept",
      content: { answer: "先补测试再实现" },
    });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: "先补测试再实现",
      reasonSource: "plan_approval_feedback",
    });
  });

  it("ExitPlanMode：v4 allowOnce 先到 → 批准（allow）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({ requestId: "plan_race", toolName: "ExitPlanMode" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("plan_race", { optionId: "allowOnce" });
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
  });

  it("ExitPlanMode：v4 freeText 先到 → 计划反馈（deny + plan_approval_feedback）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({ requestId: "plan_fb", toolName: "ExitPlanMode" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("plan_fb", { freeText: "先补测试再实现" });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: "先补测试再实现",
      reasonSource: "plan_approval_feedback",
    });
  });

  // ── Session always-allow (docs/dynamic-workflow/launch.md "Always allow in this session") ──
  // The session semantics are synthesized on the answer side: an option response on the wire
  // cannot carry permissionUpdates (strict schema), so the broker, on an exact allow_session hit,
  // hands sessionPermissionUpdates to core (in-memory only, never written to project rules).

  it("CreateWorkflow：v4 allowSession → allow + sessionPermissionUpdates，无项目级 permissionUpdates", async () => {
    const { broker, registry, requestClient } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_session",
        toolName: "CreateWorkflow",
        input: { script: "return 1;" },
        optionsPolicy: "session-always-allow",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // The v3 reverse RPC's option list does not offer the session option: an old desktop sends the
    // response back verbatim and cannot recognize the session semantics.
    const v3Params = requestClient.mock.calls[0]?.[1] as { options: { kind: string }[] };
    expect(v3Params.options.map((option) => option.kind)).toEqual(["allow_once", "deny"]);

    registry.resolve("wf_session", { optionId: "allowSession" });
    const result = await pending;
    expect(result).toMatchObject({
      decision: "allow",
      sessionPermissionUpdates: [
        { behavior: "allow", rules: [{ toolName: "CreateWorkflow" }], type: "addRules" },
      ],
    });
    expect(result).not.toHaveProperty("permissionUpdates");
  });

  it("非会话策略的工具伪造 allowSession → 未知 optionId 按 deny 兜底", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({ requestId: "wf_session_spoof", toolName: "Bash" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_session_spoof", { optionId: "allowSession" });
    const result = await pending;
    expect(result.decision).toBe("deny");
    expect(result).not.toHaveProperty("sessionPermissionUpdates");
  });

  // ── workflow Refine (docs/dynamic-workflow/launch.md "Refine") ──
  // The Refine option is synthesized only in the v4 projection; the broker special-cases it by
  // toolName+optionId+freeText before the exact match.

  it("CreateWorkflow：v4 workflowRefine + freeText → deny + workflow_refine_feedback", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_refine",
        toolName: "CreateWorkflow",
        input: { script: "return 1;" },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_refine", { optionId: "workflowRefine", freeText: " 只跑三个 finder " });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      // The protocol boundary trims surrounding whitespace, same normalization as
      // AskUserQuestion answers.
      reason: "只跑三个 finder",
      reasonSource: "workflow_refine_feedback",
    });
  });

  it("CreateWorkflow：workflowRefine 无 freeText → 普通 deny 兜底，无 reasonSource", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_refine_blank",
        toolName: "CreateWorkflow",
        input: { script: "return 1;" },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_refine_blank", { optionId: "workflowRefine", freeText: "   " });
    const result = await pending;
    expect(result.decision).toBe("deny");
    expect(result.reasonSource).toBeUndefined();
  });

  it("非 CreateWorkflow 工具伪造 workflowRefine → 普通 deny 兜底，无 reasonSource", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({ requestId: "wf_refine_spoof", toolName: "Bash" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_refine_spoof", { optionId: "workflowRefine", freeText: "伪造反馈" });
    const result = await pending;
    expect(result.decision).toBe("deny");
    expect(result.reasonSource).toBeUndefined();
  });

  it("CreateWorkflow：allowOnce 语义不受 Refine 特判影响", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_allow",
        toolName: "CreateWorkflow",
        input: { script: "return 1;" },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_allow", { optionId: "allowOnce" });
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
  });

  // ── Reusable workflows: the saved source goes through the same gate (docs/dynamic-workflow/launch.md) ──
  // The special case is keyed on toolName and independent of the input shape. These cases pin that:
  // a narrowing to "only inline scripts need Refine" would cost saved-run users their only channel
  // for speaking revision feedback back to the model.

  /** Normalized input as produced by the executor's resolveInput: the script is resolved, and the provenance lives on `saved`. */
  const savedRunInput = {
    name: "release-check",
    script: 'return await agent("检查员").ask<string>("检查一遍");',
    saved: {
      name: "release-check",
      args: { target: "packages/core" },
      path: "/repo/.zcode/workflows/release-check.dwf.ts",
      scope: "project",
    },
  };

  it("CreateWorkflow（saved 源）：workflowRefine + freeText → 与内联逐字相同的反馈升级", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_refine_saved",
        toolName: "CreateWorkflow",
        input: savedRunInput,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_refine_saved", {
      optionId: "workflowRefine",
      freeText: " 只检查 packages/core ",
    });
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: "只检查 packages/core",
      reasonSource: "workflow_refine_feedback",
    });
  });

  it("CreateWorkflow（saved 源）：allowOnce 照常批准", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_allow_saved",
        toolName: "CreateWorkflow",
        input: savedRunInput,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_allow_saved", { optionId: "allowOnce" });
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
  });

  it("SaveWorkflow 伪造 workflowRefine → 普通 deny 兜底，无 reasonSource", async () => {
    // The save window has no "revise and save again" action, and the projection side does not
    // offer it the option either; even if someone forges it, the feedback-escalation channel is
    // open only to CreateWorkflow.
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_refine_save",
        toolName: "SaveWorkflow",
        input: {
          name: "release-check",
          description: "对本仓库做一次发布前检查",
          script: "return 1;",
          path: "/repo/.zcode/workflows/release-check.dwf.ts",
          overwrite: true,
          scope: "project",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_refine_save", { optionId: "workflowRefine", freeText: "改成不覆盖" });
    const result = await pending;
    expect(result.decision).toBe("deny");
    expect(result.reasonSource).toBeUndefined();
  });

  // ── Settings adjusted in the confirmation window (docs/dynamic-workflow/launch.md "Adjusting the settings in the window") ──
  // Only the **approval** answers of the two workflow tools read content; denials and Refine never
  // carry adjustments.

  it("CreateWorkflow：allowOnce + content → allow + inputAdjustments（只留认得的两个键）", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_adjust",
        toolName: "CreateWorkflow",
        input: { script: "return 1;" },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_adjust", {
      optionId: "allowOnce",
      content: { subagent_model: "openai/gpt-5", max_concurrency: null, extra: "dropped" },
    });
    const result = await pending;
    expect(result.decision).toBe("allow");
    expect(result.inputAdjustments).toEqual({ subagent_model: "openai/gpt-5", max_concurrency: null });
  });

  it("AmendWorkflow：allowSession + content → 会话授权与调整同时成立", async () => {
    const { broker, registry } = makeBrokerContext();
    const pending = broker.requestPermission(
      permissionRequest({
        requestId: "wf_adjust_session",
        toolName: "AmendWorkflow",
        input: { run_id: "dwfrun-prev", script: "return 1;" },
        optionsPolicy: "session-always-allow",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_adjust_session", {
      optionId: "allowSession",
      content: { max_concurrency: 3 },
    });
    await expect(pending).resolves.toMatchObject({
      decision: "allow",
      inputAdjustments: { max_concurrency: 3 },
      sessionPermissionUpdates: [
        { behavior: "allow", rules: [{ toolName: "AmendWorkflow" }], type: "addRules" },
      ],
    });
  });

  it("拒绝与 Refine 带 content 也不产生调整", async () => {
    const { broker, registry } = makeBrokerContext();
    const denied = broker.requestPermission(
      permissionRequest({ requestId: "wf_adjust_deny", toolName: "CreateWorkflow" }),
    );
    const refined = broker.requestPermission(
      permissionRequest({ requestId: "wf_adjust_refine", toolName: "CreateWorkflow" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_adjust_deny", { optionId: "deny", content: { max_concurrency: 3 } });
    registry.resolve("wf_adjust_refine", {
      optionId: "workflowRefine",
      freeText: "少跑几个",
      content: { max_concurrency: 3 },
    });
    expect(await denied).not.toHaveProperty("inputAdjustments");
    expect(await refined).not.toHaveProperty("inputAdjustments");
  });

  it("别的工具的 allow 带 content 不产生调整；形状不对的 content 整份作废", async () => {
    const { broker, registry } = makeBrokerContext();
    const bash = broker.requestPermission(
      permissionRequest({ requestId: "wf_adjust_bash", toolName: "Bash" }),
    );
    const malformed = broker.requestPermission(
      permissionRequest({ requestId: "wf_adjust_bad", toolName: "CreateWorkflow" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    registry.resolve("wf_adjust_bash", { optionId: "allowOnce", content: { max_concurrency: 3 } });
    registry.resolve("wf_adjust_bad", { optionId: "allowOnce", content: { max_concurrency: 0 } });
    const bashResult = await bash;
    const malformedResult = await malformed;
    expect(bashResult.decision).toBe("allow");
    expect(bashResult).not.toHaveProperty("inputAdjustments");
    expect(malformedResult.decision).toBe("allow");
    expect(malformedResult).not.toHaveProperty("inputAdjustments");
  });
});

// ── dwf event log query (docs/dynamic-workflow/presentation.md "The run pane") ──
// The shape is deliberately in the same family as rows/range and plans (read-only, stateless,
// safe to resend on timeout) and **not** a v4 command:
// a command's ACK result is the closed "mutation result" discriminated union of
// commandResultSchema; a page of read-only events does not belong to that vocabulary and would
// pointlessly carry the baseRevision / idempotency machinery.
describe("v4 conversation workflowRunEvents query", () => {
  function makeGateway(
    listDynamicWorkflowRunEvents?: (
      sessionId: string,
      input: { runId: string; afterSequence?: number; limit?: number; maxBytes?: number },
    ) => Promise<DynamicWorkflowRunEventsResult>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(listDynamicWorkflowRunEvents ? { listDynamicWorkflowRunEvents } : {}),
    });
  }

  const event = (sequence: number): DynamicWorkflowRunEvent => ({
    sequence,
    type: "node-settled",
    payload: { instance: { siteId: "ask#1", ordinal: sequence }, outcome: "ok" },
  });

  it("cursor、limit 与字节上界透传到端口（分页在存储层，不在 RPC 层切片）", async () => {
    const listEvents = vi.fn(async () => ({ events: [event(5), event(6)], hasMore: false }));
    const result = await makeGateway(listEvents).workflowRunEvents({
      sessionId: "s1",
      runId: "dwfrun-1",
      afterSequence: 4,
      limit: 2,
    });

    // The byte bound is always the protocol cap: the renderer cannot loosen it, and the page's
    // hasMore is decided by the storage layer.
    expect(listEvents).toHaveBeenCalledWith("s1", {
      runId: "dwfrun-1",
      afterSequence: 4,
      limit: 2,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    expect(result.events.map((item) => item.sequence)).toEqual([5, 6]);
    expect(result.hasMore).toBe(false);
  });

  it("不给 limit 时按协议上限（500 条）取；hasMore 原样取存储层的判定", async () => {
    // A page may end early because of the byte budget: if the storage layer says there is more,
    // there is more — even when this page is far short of the limit.
    const listEvents = vi.fn(async () => ({ events: [event(1)], hasMore: true }));
    const result = await makeGateway(listEvents).workflowRunEvents({
      sessionId: "s1",
      runId: "dwfrun-1",
    });

    expect(listEvents).toHaveBeenCalledWith("s1", {
      runId: "dwfrun-1",
      limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    expect(result).toEqual({ events: [event(1)], hasMore: true });
  });

  it("越界 cursor 得到空页而不是报错（投影与 journal 之间有竞态窗口）", async () => {
    const result = await makeGateway(async () => ({
      events: [],
      hasMore: false,
    })).workflowRunEvents({
      sessionId: "s1",
      runId: "dwfrun-1",
      afterSequence: 9_999,
    });
    expect(result).toEqual({ events: [], hasMore: false });
  });

  it("能力缺席 → 结构化的能力不支持错误，而不是静默空页", async () => {
    // "No events" and "this session lacks the capability" must be distinguishable by the renderer:
    // the latter means the dwf journal is unavailable (the run service was never constructed).
    const run = makeGateway().workflowRunEvents({ sessionId: "s1", runId: "dwfrun-1" });
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  it("未知参数被 strict schema 拒收", async () => {
    await expect(
      makeGateway(async () => ({ events: [], hasMore: false })).workflowRunEvents({
        sessionId: "s1",
        runId: "dwfrun-1",
        cwd: "/repo",
      }),
    ).rejects.toThrow();
  });

  it("冷会话：先把宿主 record 拉起来再读 journal（否则事件日志在重启后恒空）", async () => {
    // Same precondition as the enumeration query, see
    // apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
    // "journal 读面的冷会话前置" (the cold-session precondition of the journal read face). This is
    // the second call site — both must carry it; missing one yields
    // "the detail page opens but the log can never be read".
    const calls: string[] = [];
    let registered = false;
    const gateway = new ConversationV4Gateway({
      sessionExists: () => registered,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      listDynamicWorkflowRunEvents: async () => {
        calls.push("list");
        return { events: [event(1)], hasMore: false };
      },
      resumePersistedSession: async () => {
        calls.push("resume");
        registered = true;
        return { status: "resumed" };
      },
    });

    const result = await gateway.workflowRunEvents({ sessionId: "s1", runId: "dwfrun-1" });
    expect(calls).toEqual(["resume", "list"]);
    expect(result.events.map((item) => item.sequence)).toEqual([1]);
  });

  it("detached live 会话（运行中的 dwf actor）：journal 读绝不冷恢复出第二个 runtime", async () => {
    // Bug root cause (observed 2026-08-24): the nested SessionPane of an actor transcript used to
    // send this query with the actor session id, and the cold-session precondition only looked at
    // sessionExists — a detached live session deliberately has no host record, so a ghost runtime
    // got materialized for a **live** session (double-written event log, frozen live stream).
    // The precondition must use the same liveness check as subscribe: detached live also counts as
    // live; skip the resume.
    const calls: string[] = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => false,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      listDynamicWorkflowRunEvents: async () => {
        calls.push("list");
        return { events: [], hasMore: false };
      },
      resumePersistedSession: async () => {
        calls.push("resume");
        return { status: "resumed" };
      },
    });
    gateway.ingestDetachedLiveSession("s-actor", detachedLiveEvent("s-actor"));

    const result = await gateway.workflowRunEvents({ sessionId: "s-actor", runId: "dwfrun-1" });
    expect(calls).toEqual(["list"]);
    expect(result).toEqual({ events: [], hasMore: false });
  });
});

// ── dwf run enumeration query (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Cancel and resume") ──
// The journal-backed discovery surface after a restart: the workflowRuns projection is
// memory-only and empty after a restart, so tool-card joins and Resume button availability can
// only be reconstructed from this query.
describe("v4 conversation workflowRuns query", () => {
  function makeGateway(
    listDynamicWorkflowRuns?: (
      sessionId: string,
      input: { limit?: number },
    ) => Promise<DynamicWorkflowRunSessionSummary[]>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(listDynamicWorkflowRuns ? { listDynamicWorkflowRuns } : {}),
    });
  }

  const summary: DynamicWorkflowRunSessionSummary = {
    runId: "dwfrun-1",
    toolCallId: "call-1",
    status: "stopped",
    stopReason: "user",
    resumable: true,
  };

  it("limit 透传到能力面；resumable 由 CLI 算好、原样回传", async () => {
    const listRuns = vi.fn(async () => [summary]);
    const result = await makeGateway(listRuns).workflowRuns({ sessionId: "s1", limit: 8 });

    expect(listRuns).toHaveBeenCalledWith("s1", { limit: 8 });
    expect(result.runs).toEqual([summary]);
  });

  it("能力缺席 → 结构化的能力不支持错误，而不是静默空列表", async () => {
    const run = makeGateway().workflowRuns({ sessionId: "s1" });
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  it("未知参数被 strict schema 拒收", async () => {
    await expect(
      makeGateway(async () => []).workflowRuns({ sessionId: "s1", cwd: "/repo" }),
    ).rejects.toThrow();
  });

  it("结果键集恰为 {runs}（.strict()：以后顺手加字段会先在这里红）", async () => {
    const result = await makeGateway(async () => []).workflowRuns({ sessionId: "s1" });
    expect(Object.keys(result)).toEqual(["runs"]);
  });

  // ── Cold-session precondition (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Resume by replay") ──
  // Bug root cause: this query looks up the host record by sessionId, and historical sessions were
  // only activated by the **subscribe** path; the renderer's discovery-query effect is declared
  // before the lease/subscribe effect and the CLI processes requests strictly serially, so when a
  // historical session is opened after a restart the query necessarily lands before the subscribe
  // and necessarily gets sessionNotFound — the tool cards' join fallback disappears wholesale and
  // the cards fall back to the "compiled but no run" compile state.
  function makeColdGateway(options: {
    listDynamicWorkflowRuns?: (
      sessionId: string,
      input: { limit?: number },
    ) => Promise<DynamicWorkflowRunSessionSummary[]>;
    registered?: boolean;
    trace: string[];
  }) {
    let registered = options.registered ?? false;
    return new ConversationV4Gateway({
      sessionExists: () => registered,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(options.listDynamicWorkflowRuns
        ? { listDynamicWorkflowRuns: options.listDynamicWorkflowRuns }
        : {}),
      resumePersistedSession: async () => {
        options.trace.push("resume");
        registered = true;
        return { status: "resumed" };
      },
    });
  }

  it("冷会话：先把宿主 record 拉起来，再打能力面（顺序就是这条 query 能不能用）", async () => {
    const trace: string[] = [];
    const gateway = makeColdGateway({
      trace,
      listDynamicWorkflowRuns: async () => {
        trace.push("list");
        return [summary];
      },
    });

    const result = await gateway.workflowRuns({ sessionId: "s1" });
    expect(trace).toEqual(["resume", "list"]);
    expect(result.runs).toEqual([summary]);
  });

  it("会话已在册：不重复激活（读一页 run 不该顺手拉起第二个 runtime）", async () => {
    const trace: string[] = [];
    const gateway = makeColdGateway({
      trace,
      registered: true,
      listDynamicWorkflowRuns: async () => {
        trace.push("list");
        return [summary];
      },
    });

    await gateway.workflowRuns({ sessionId: "s1" });
    expect(trace).toEqual(["list"]);
  });

  it("能力缺席仍先于 resume 短路：稳定事实不值得先激活一个 runtime", async () => {
    const trace: string[] = [];
    const gateway = makeColdGateway({ trace });

    await expect(gateway.workflowRuns({ sessionId: "s1" })).rejects.toThrow(
      V4CapabilityUnsupportedError,
    );
    expect(trace).toEqual([]);
  });

  it("detached live 会话（运行中的 dwf actor）：枚举 query 同样不冷恢复第二个 runtime", async () => {
    // Same root cause as the detached test of the event log query: the two journal read faces
    // share the same precondition; either one missing the detached check materializes a ghost
    // runtime for a live session.
    const trace: string[] = [];
    const gateway = makeColdGateway({
      trace,
      listDynamicWorkflowRuns: async () => {
        trace.push("list");
        return [];
      },
    });
    gateway.ingestDetachedLiveSession("s1", detachedLiveEvent("s1"));

    const result = await gateway.workflowRuns({ sessionId: "s1" });
    expect(trace).toEqual(["list"]);
    expect(result.runs).toEqual([]);
  });
});

// ── The three user-facing artifact queries (docs/dynamic-workflow/authoring.md "How the user sees them") ──
// ⚠ Terminology: artifact = output the script published **to the user** via `artifact.*`, not the
// run's top-level return value (the engine's internal same-named notion for the latter). The
// spec's "terminology" table is the only disambiguation point.
//
// The three are in the same family as workflowRunEvents: read-only, stateless, safe to resend on
// timeout, and carrying the same cold-session precondition.
// ArtifactRead's **authorization lives on the host port side** (the run belongs to that session ∧
// the journal has a completed row for that version ⇒ only then is the row's uri used to read from
// the store); the gateway only validates parameters and chunks, deliberately holding no second
// copy of the criteria — if both places checked, the same id would sooner or later get different
// interpretations at the two layers.
describe("v4 conversation workflowRunArtifacts query", () => {
  function makeGateway(
    listDynamicWorkflowRunArtifacts?: (
      sessionId: string,
      input: { runId: string },
    ) => Promise<readonly DynamicWorkflowRunArtifact[] | undefined>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(listDynamicWorkflowRunArtifacts ? { listDynamicWorkflowRunArtifacts } : {}),
    });
  }

  const artifact: DynamicWorkflowRunArtifact = {
    id: "book",
    kind: "file",
    title: "注意力之书",
    contentType: "application/pdf",
    sourcePath: "out/book.pdf",
    version: 2,
    versions: [
      { version: 1, bytes: 10, publishedAt: 1 },
      { version: 2, bytes: 20, publishedAt: 2 },
    ],
    itemCount: 0,
  };

  it("清单原样透传（全部版本 + itemCount，字节永不在这条 query 上）", async () => {
    const list = vi.fn(async () => [artifact]);
    const result = await makeGateway(list).workflowRunArtifacts({
      sessionId: "s1",
      runId: "dwfrun-1",
    });
    expect(list).toHaveBeenCalledWith("s1", { runId: "dwfrun-1" });
    expect(result).toEqual({ artifacts: [artifact] });
  });

  it("未知 run（端口回 undefined）得到空清单而不是报错", async () => {
    // An evicted / never-existing run has no artifacts; that is a fact, not a failure.
    const result = await makeGateway(async () => undefined).workflowRunArtifacts({
      sessionId: "s1",
      runId: "dwfrun-gone",
    });
    expect(result).toEqual({ artifacts: [] });
  });

  it("能力缺席 → 结构化的能力不支持错误，而不是静默空清单", async () => {
    const run = makeGateway().workflowRunArtifacts({ sessionId: "s1", runId: "dwfrun-1" });
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  it("未知参数被 strict schema 拒收", async () => {
    await expect(
      makeGateway(async () => []).workflowRunArtifacts({
        sessionId: "s1",
        runId: "dwfrun-1",
        limit: 5,
      }),
    ).rejects.toThrow();
  });

  it("冷会话：先把宿主 record 拉起来再读 journal（否则冷恢复后侧板恒空）", async () => {
    const calls: string[] = [];
    let registered = false;
    const gateway = new ConversationV4Gateway({
      sessionExists: () => registered,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      listDynamicWorkflowRunArtifacts: async () => {
        calls.push("list");
        return [artifact];
      },
      resumePersistedSession: async () => {
        calls.push("resume");
        registered = true;
        return { status: "resumed" };
      },
    });
    await gateway.workflowRunArtifacts({ sessionId: "s1", runId: "dwfrun-1" });
    expect(calls).toEqual(["resume", "list"]);
  });
});

describe("v4 conversation workflowRunArtifactData query", () => {
  function makeGateway(
    listDynamicWorkflowRunArtifactItems?: (
      sessionId: string,
      input: {
        runId: string;
        artifactId: string;
        afterSequence?: number;
        limit: number;
        maxBytes: number;
      },
    ) => Promise<DynamicWorkflowRunArtifactItemsResult>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(listDynamicWorkflowRunArtifactItems ? { listDynamicWorkflowRunArtifactItems } : {}),
    });
  }

  const item = (sequence: number): DynamicWorkflowRunArtifactItem => ({
    sequence,
    siteId: "report#1",
    ordinal: sequence,
    item: { round: sequence, ms: 40 - sequence },
  });
  const empty = async () => ({ items: [], hasMore: false });
  const maxBytes = WORKFLOW_ARTIFACT_LIMITS.maxPageBytes;

  it("limit 缺省 200、钳在 [1,500]；字节上界恒为协议上限", async () => {
    const list = vi.fn(empty);
    const gateway = makeGateway(list);
    await gateway.workflowRunArtifactData({ sessionId: "s1", runId: "r", artifactId: "perf" });
    expect(list).toHaveBeenLastCalledWith("s1", {
      runId: "r",
      artifactId: "perf",
      limit: 200,
      maxBytes,
    });

    await gateway.workflowRunArtifactData({
      sessionId: "s1",
      runId: "r",
      artifactId: "perf",
      limit: 500,
    });
    expect(list).toHaveBeenLastCalledWith("s1", {
      runId: "r",
      artifactId: "perf",
      limit: 500,
      maxBytes,
    });
  });

  it("cursor 透传；hasMore 原样取存储层的判定（页可能因字节提前收尾）", async () => {
    const list = vi.fn(async () => ({ items: [item(5)], hasMore: true }));
    const result = await makeGateway(list).workflowRunArtifactData({
      sessionId: "s1",
      runId: "r",
      artifactId: "perf",
      afterSequence: 4,
      limit: 2,
    });
    expect(list).toHaveBeenCalledWith("s1", {
      runId: "r",
      artifactId: "perf",
      afterSequence: 4,
      limit: 2,
      maxBytes,
    });
    expect(result.items.map((entry) => entry.sequence)).toEqual([5]);
    expect(result.hasMore).toBe(true);
  });

  it("条目原值透传（不做预览序列化——看板要按字段路径取数）", async () => {
    const result = await makeGateway(async () => ({
      items: [item(7)],
      hasMore: false,
    })).workflowRunArtifactData({
      sessionId: "s1",
      runId: "r",
      artifactId: "perf",
    });
    expect(result.items[0]?.item).toEqual({ round: 7, ms: 33 });
    expect(result.hasMore).toBe(false);
  });

  it("能力缺席 → 结构化的能力不支持错误", async () => {
    await expect(
      makeGateway().workflowRunArtifactData({ sessionId: "s1", runId: "r", artifactId: "perf" }),
    ).rejects.toThrow(V4CapabilityUnsupportedError);
  });

  it("limit 越界被 strict schema 拒收（钳制只对缺省与合法值生效）", async () => {
    await expect(
      makeGateway(empty).workflowRunArtifactData({
        sessionId: "s1",
        runId: "r",
        artifactId: "perf",
        limit: 501,
      }),
    ).rejects.toThrow();
  });
});

describe("v4 conversation workflowRunArtifactRead query", () => {
  function makeGateway(
    readDynamicWorkflowRunArtifact?: (
      sessionId: string,
      input: { runId: string; artifactId: string; version: number },
    ) => Promise<{ bytes: Uint8Array; contentType: string } | undefined>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(readDynamicWorkflowRunArtifact ? { readDynamicWorkflowRunArtifact } : {}),
    });
  }

  const bytes = new Uint8Array(Array.from({ length: 10 }, (_value, index) => index));
  const readOk = async () => ({ bytes, contentType: "application/pdf" });

  it("按 offset/limit 分块，nextOffset 指向下一块、读到尾为 null", async () => {
    const gateway = makeGateway(readOk);
    const first = await gateway.workflowRunArtifactRead({
      sessionId: "s1",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset: 0,
      limit: 4,
    });
    expect(Buffer.from(first.dataBase64, "base64")).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(first).toMatchObject({ mediaType: "application/pdf", totalBytes: 10, nextOffset: 4 });

    const last = await gateway.workflowRunArtifactRead({
      sessionId: "s1",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset: 8,
      limit: 4,
    });
    expect(Buffer.from(last.dataBase64, "base64")).toEqual(Buffer.from([8, 9]));
    expect(last.nextOffset).toBeNull();
  });

  it("offset 越界得到空块 + nextOffset null（与读到尾同一形态，不是错误）", async () => {
    const result = await makeGateway(readOk).workflowRunArtifactRead({
      sessionId: "s1",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset: 9_999,
      limit: 4,
    });
    expect(result.dataBase64).toBe("");
    expect(result).toMatchObject({ totalBytes: 10, nextOffset: null });
  });

  it("授权负例：宿主拒绝（不是你的 run / 未知版本 / 是块看板）⇒ notFound，三者不可区分", async () => {
    // The port normalizes all three denials to undefined, and the gateway returns the same fault
    // accordingly. Distinguishing them would only tell an unauthorized caller which half it
    // guessed right — the same discipline as the attachmentRead bugfix.
    const gateway = makeGateway(async () => undefined);
    await expect(
      gateway.workflowRunArtifactRead({
        sessionId: "s1",
        runId: "r",
        artifactId: "book",
        version: 3,
        offset: 0,
        limit: 4,
      }),
    ).rejects.toThrow(/fault\.workflowRunArtifactRead\.notFound/);
  });

  it("授权负例：网关**自己不读 store**——版本与身份只经宿主端口，参数原样下传", async () => {
    const read = vi.fn(readOk);
    await makeGateway(read).workflowRunArtifactRead({
      sessionId: "s1",
      runId: "dwfrun-1",
      artifactId: "book",
      version: 2,
      offset: 0,
      limit: 4,
    });
    // sessionId goes down too: step ② of the authorization chain (the run's parentSessionId must
    // equal it) lives on the port side.
    expect(read).toHaveBeenCalledWith("s1", {
      runId: "dwfrun-1",
      artifactId: "book",
      version: 2,
    });
  });

  it("能力缺席 → 结构化的能力不支持错误", async () => {
    await expect(
      makeGateway().workflowRunArtifactRead({
        sessionId: "s1",
        runId: "r",
        artifactId: "book",
        version: 1,
        offset: 0,
        limit: 4,
      }),
    ).rejects.toThrow(V4CapabilityUnsupportedError);
  });

  it("limit 超过 512 KiB 块界被 strict schema 拒收（host→CLI 每请求 ≤ 1 MiB 的既有证明）", async () => {
    await expect(
      makeGateway(readOk).workflowRunArtifactRead({
        sessionId: "s1",
        runId: "r",
        artifactId: "book",
        version: 1,
        offset: 0,
        limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 1,
      }),
    ).rejects.toThrow();
  });

  // ── The chunked-read cache (an efficiency flaw found during the 2026-09-04 implementation review) ────────────────────────
  // The port's readArtifact returns the **whole** byte payload, while this query is chunked:
  // without caching, fetching a 20 MiB PDF in 512 KiB chunks of 40 would read the whole file from
  // the store 40 times (800 MiB of I/O), with every chunk also re-walking the journal
  // authorization chain. Reuses the attachmentRead table (TTL / byte budget / oldest evicted
  // first).
  describe("整份字节的缓存", () => {
    function makeCachingGateway(now: () => number) {
      const read = vi.fn(async () => ({ bytes, contentType: "application/pdf" }));
      const gateway = new ConversationV4Gateway(
        {
          sessionExists: (sessionId) => sessionId === "s1",
          emitWireFrame: () => {},
          executeCommand: async () => undefined,
          readDynamicWorkflowRunArtifact: read,
        },
        { now },
      );
      return { gateway, read };
    }

    const chunk = (offset: number) => ({
      sessionId: "s1",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset,
      limit: 4,
    });

    it("一整条分块序列只读一次宿主（这条缺失就是 N 块读 N 遍整份文件）", async () => {
      const { gateway, read } = makeCachingGateway(() => 1_000);
      const first = await gateway.workflowRunArtifactRead(chunk(0));
      const second = await gateway.workflowRunArtifactRead(chunk(4));
      const third = await gateway.workflowRunArtifactRead(chunk(8));

      expect(read).toHaveBeenCalledTimes(1);
      // Caching does not change the chunking result: the three chunks reassemble the original
      // bytes.
      expect(
        Buffer.concat(
          [first, second, third].map((page) => Buffer.from(page.dataBase64, "base64")),
        ),
      ).toEqual(Buffer.from(bytes));
      expect(third.nextOffset).toBeNull();
    });

    it("并发抓取的多块共享同一次在飞读取（缓存的是 promise，不是结果）", async () => {
      const { gateway, read } = makeCachingGateway(() => 1_000);
      await Promise.all([0, 4, 8].map((offset) => gateway.workflowRunArtifactRead(chunk(offset))));
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("TTL 到期后重新读一次宿主", async () => {
      let clock = 1_000;
      const { gateway, read } = makeCachingGateway(() => clock);
      await gateway.workflowRunArtifactRead(chunk(0));
      expect(read).toHaveBeenCalledTimes(1);

      clock += PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs + 1;
      await gateway.workflowRunArtifactRead(chunk(4));
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("版本 / 产物 / run / 会话各是不同的键——缓存绝不跨身份复用", async () => {
      // sessionId in particular: it is exactly what the port's authorization chain compares
      // against, so a session change must go back through the port.
      const { gateway, read } = makeCachingGateway(() => 1_000);
      await gateway.workflowRunArtifactRead(chunk(0));
      await gateway.workflowRunArtifactRead({ ...chunk(0), version: 2 });
      await gateway.workflowRunArtifactRead({ ...chunk(0), artifactId: "other" });
      await gateway.workflowRunArtifactRead({ ...chunk(0), runId: "r2" });
      expect(read).toHaveBeenCalledTimes(4);
    });

    it("拒绝不被负缓存：下一次请求重新问宿主（发布落库与读之间有竞态窗口）", async () => {
      let artifactExists = false;
      const read = vi.fn(async () =>
        artifactExists ? { bytes, contentType: "application/pdf" } : undefined,
      );
      const gateway = new ConversationV4Gateway(
        {
          sessionExists: (sessionId) => sessionId === "s1",
          emitWireFrame: () => {},
          executeCommand: async () => undefined,
          readDynamicWorkflowRunArtifact: read,
        },
        { now: () => 1_000 },
      );

      await expect(gateway.workflowRunArtifactRead(chunk(0))).rejects.toThrow(
        /fault\.workflowRunArtifactRead\.notFound/,
      );
      artifactExists = true;
      // Had undefined been cached, this request would keep reporting notFound for 30 seconds.
      await expect(gateway.workflowRunArtifactRead(chunk(0))).resolves.toMatchObject({
        totalBytes: 10,
      });
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  it("冷会话：先把宿主 record 拉起来再读字节", async () => {
    const calls: string[] = [];
    let registered = false;
    const gateway = new ConversationV4Gateway({
      sessionExists: () => registered,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      readDynamicWorkflowRunArtifact: async () => {
        calls.push("read");
        return { bytes, contentType: "application/pdf" };
      },
      resumePersistedSession: async () => {
        calls.push("resume");
        registered = true;
        return { status: "resumed" };
      },
    });
    await gateway.workflowRunArtifactRead({
      sessionId: "s1",
      runId: "r",
      artifactId: "book",
      version: 1,
      offset: 0,
      limit: 4,
    });
    expect(calls).toEqual(["resume", "read"]);
  });
});


describe("v4 原生 resumeWorkflowRun", () => {
  function makeRecord(app: Record<string, unknown>): V4SessionRecordView {
    return {
      app,
      workspace: { workspacePath: "/w" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView;
  }

  it("正路径：workId ≡ runId 直传 app 能力，携可选 name（经 app 调用保 this 绑定）", async () => {
    const resumeWorkflowRun = vi
      .fn()
      .mockResolvedValue({ ok: true, runId: "dwfrun-1", toolCallId: "call-1" });
    const record = makeRecord({ sessionId: "s1", resumeWorkflowRun });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    await new V4CommandExecutor(host).execute(
      envelope("resumeWorkflowRun", { workId: "dwfrun-1", name: "Nightly audit" }),
    );
    expect(resumeWorkflowRun).toHaveBeenCalledWith({ workId: "dwfrun-1", name: "Nightly audit" });
  });

  it("name 缺席时不落成 undefined 键", async () => {
    const resumeWorkflowRun = vi.fn().mockResolvedValue({ ok: true, runId: "dwfrun-1" });
    const record = makeRecord({ sessionId: "s1", resumeWorkflowRun });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    await new V4CommandExecutor(host).execute(
      envelope("resumeWorkflowRun", { workId: "dwfrun-1" }),
    );
    expect(resumeWorkflowRun).toHaveBeenCalledWith({ workId: "dwfrun-1" });
  });

  it("能力不支持：app 无 resumeWorkflowRun → 结构化 reasonCode 错误", async () => {
    const record = makeRecord({ sessionId: "s1" });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("resumeWorkflowRun", { workId: "dwfrun-1" }),
    );
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  // A business rejection is neither a missing capability nor an execution crash: each of the five
  // reasons is forwarded with a stable reasonCode, and the UI routes on the vocabulary (not on
  // error text for flow decisions).
  it("业务拒绝以 fault.command.workflowRunResumeRejected.<reason> 上行", async () => {
    const resumeWorkflowRun = vi.fn().mockResolvedValue({ ok: false, reason: "not_resumable" });
    const record = makeRecord({ sessionId: "s1", resumeWorkflowRun });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("resumeWorkflowRun", { workId: "dwfrun-1" }),
    );
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.workflowRunResumeRejected.not_resumable",
    });
  });

  // compile_failed (an old run from before the facade refactor): the port's bounded diagnostics
  // reach ack.message via error.message.
  it("compile_failed 的诊断随 message 上行", async () => {
    const resumeWorkflowRun = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "compile_failed", message: "L2:C7 old facade" });
    const record = makeRecord({ sessionId: "s1", resumeWorkflowRun });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("resumeWorkflowRun", { workId: "dwfrun-1" }),
    );
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.workflowRunResumeRejected.compile_failed",
      message: "L2:C7 old facade",
    });
  });
});

// The hub starts a saved workflow directly (docs/dynamic-workflow/launch.md): an
// interaction-background handler in the same family as resume. Three tiers: missing capability,
// business rejection (reason + human-readable message), success result.
describe("v4 原生 startSavedWorkflow", () => {
  function makeRecord(app: Record<string, unknown>): V4SessionRecordView {
    return {
      app,
      workspace: { workspacePath: "/w" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView;
  }

  it("正路径：payload 直传 app 能力，成功回 { type, runId, toolCallId } result", async () => {
    const startSavedWorkflow = vi
      .fn()
      .mockResolvedValue({ ok: true, runId: "dwfrun-9", toolCallId: "launch-abc" });
    const record = makeRecord({ sessionId: "s1", startSavedWorkflow });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const result = await new V4CommandExecutor(host).execute(
      envelope("startSavedWorkflow", {
        name: "deep-research",
        scope: "global",
        args: { topic: "adaptive concurrency" },
      }),
    );
    expect(startSavedWorkflow).toHaveBeenCalledWith({
      name: "deep-research",
      scope: "global",
      args: { topic: "adaptive concurrency" },
    });
    expect(result).toEqual({
      type: "startSavedWorkflow",
      runId: "dwfrun-9",
      toolCallId: "launch-abc",
    });
  });

  it("scope / args 缺席时不落成 undefined 键", async () => {
    const startSavedWorkflow = vi
      .fn()
      .mockResolvedValue({ ok: true, runId: "dwfrun-9", toolCallId: "launch-abc" });
    const record = makeRecord({ sessionId: "s1", startSavedWorkflow });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    await new V4CommandExecutor(host).execute(envelope("startSavedWorkflow", { name: "tidy" }));
    expect(startSavedWorkflow).toHaveBeenCalledWith({ name: "tidy" });
  });

  it("能力不支持：app 无 startSavedWorkflow → capabilityUnsupported（GUI 原样显示、回收空会话）", async () => {
    const record = makeRecord({ sessionId: "s1" });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("startSavedWorkflow", { name: "deep-research" }),
    );
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.capabilityUnsupported",
    });
  });

  // Business rejection: reason → stable fault code (the UI routes on the vocabulary), message →
  // error.message (the gateway folds it into ack.message).
  it("业务拒绝以 fault.command.savedWorkflowStartRejected.<reason> 上行并携人可读 message", async () => {
    const startSavedWorkflow = vi.fn().mockResolvedValue({
      ok: false,
      reason: "compile_failed",
      message: "script.ts(3,10): expected ';'",
    });
    const record = makeRecord({ sessionId: "s1", startSavedWorkflow });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("startSavedWorkflow", { name: "broken" }),
    );
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.savedWorkflowStartRejected.compile_failed",
      message: "script.ts(3,10): expected ';'",
    });
  });

  it("拒绝无 message 时给可读兜底（不抛裸 reason）", async () => {
    const startSavedWorkflow = vi.fn().mockResolvedValue({ ok: false, reason: "session_busy" });
    const record = makeRecord({ sessionId: "s1", startSavedWorkflow });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(envelope("startSavedWorkflow", { name: "x" }));
    await expect(run).rejects.toMatchObject({
      reasonCode: "fault.command.savedWorkflowStartRejected.session_busy",
      message: "saved workflow start rejected: session_busy",
    });
  });
});

// GUI "settings" (docs/dynamic-workflow/launch.md "Changing a run's settings from the GUI"): an
// interaction-background handler in the same family as resume. The three states pass through
// as-is, rejections go up with a stable fault code, success returns the new run's join keys.
describe("v4 原生 amendWorkflowRunSettings", () => {
  function makeRecord(app: Record<string, unknown>): V4SessionRecordView {
    return {
      app,
      workspace: { workspacePath: "/w" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView;
  }

  it("正路径：workId → runId，null 原样下传，成功回 { type, runId, toolCallId, supersededRunId }", async () => {
    const amendWorkflowRunSettings = vi.fn().mockResolvedValue({
      ok: true,
      runId: "dwfrun-b",
      toolCallId: "settings-abc",
      supersededRunId: "dwfrun-a",
    });
    const record = makeRecord({ sessionId: "s1", amendWorkflowRunSettings });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const result = await new V4CommandExecutor(host).execute(
      envelope("amendWorkflowRunSettings", {
        workId: "dwfrun-a",
        subagentModel: null,
        maxConcurrency: 4,
      }),
    );
    expect(amendWorkflowRunSettings).toHaveBeenCalledWith({
      runId: "dwfrun-a",
      subagentModel: null,
      maxConcurrency: 4,
    });
    expect(result).toEqual({
      type: "amendWorkflowRunSettings",
      runId: "dwfrun-b",
      toolCallId: "settings-abc",
      supersededRunId: "dwfrun-a",
    });
  });

  it("省略的设置不落成 undefined 键；前驱已结算时结果不带 supersededRunId", async () => {
    const amendWorkflowRunSettings = vi
      .fn()
      .mockResolvedValue({ ok: true, runId: "dwfrun-b", toolCallId: "settings-abc" });
    const record = makeRecord({ sessionId: "s1", amendWorkflowRunSettings });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const result = await new V4CommandExecutor(host).execute(
      envelope("amendWorkflowRunSettings", { workId: "dwfrun-a", maxConcurrency: 2 }),
    );
    expect(amendWorkflowRunSettings).toHaveBeenCalledWith({ runId: "dwfrun-a", maxConcurrency: 2 });
    expect(result).toEqual({
      type: "amendWorkflowRunSettings",
      runId: "dwfrun-b",
      toolCallId: "settings-abc",
    });
  });

  it("能力不支持：app 无 amendWorkflowRunSettings → capabilityUnsupported", async () => {
    const record = makeRecord({ sessionId: "s1" });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });

    const run = new V4CommandExecutor(host).execute(
      envelope("amendWorkflowRunSettings", { workId: "dwfrun-a", maxConcurrency: 2 }),
    );
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
  });

  it("业务拒绝以 fault.command.workflowRunSettingsRejected.<reason> 上行，message 随行或给兜底", async () => {
    const amendWorkflowRunSettings = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "compile_failed", message: "L1:C7 bad" })
      .mockResolvedValueOnce({ ok: false, reason: "unchanged" });
    const record = makeRecord({ sessionId: "s1", amendWorkflowRunSettings });
    const host = makeHost({ getRecord: (id) => (id === "s1" ? record : undefined) });
    const executor = new V4CommandExecutor(host);

    await expect(
      executor.execute(envelope("amendWorkflowRunSettings", { workId: "a", maxConcurrency: 2 })),
    ).rejects.toMatchObject({
      reasonCode: "fault.command.workflowRunSettingsRejected.compile_failed",
      message: "L1:C7 bad",
    });
    await expect(
      executor.execute(envelope("amendWorkflowRunSettings", { workId: "a", maxConcurrency: 2 })),
    ).rejects.toMatchObject({
      reasonCode: "fault.command.workflowRunSettingsRejected.unchanged",
      message: "workflow run settings rejected: unchanged",
    });
  });
});

// ── The two read faces of the workspace transcript (docs/dynamic-workflow/transcript-and-notifications.md) ──
// Following the artifacts ①/③: an empty listing is a fact, not a failure; the body's authorization
// is entirely host-side, and the gateway only validates parameters and clamps maxBytes.
describe("v4 conversation workflowRunWorkspace query", () => {
  function makeGateway(
    listDynamicWorkflowRunWorkspaceNodes?: (
      sessionId: string,
      input: { runId: string },
    ) => Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(listDynamicWorkflowRunWorkspaceNodes ? { listDynamicWorkflowRunWorkspaceNodes } : {}),
    });
  }

  const node: DynamicWorkflowRunWorkspaceNode = {
    siteId: "world-read#1",
    ordinal: 1,
    kind: "world-run",
    op: "run",
    args: ["pnpm", ["test"]],
    status: "completed",
    summary: { resultBytes: 40, exitCode: 0, stdoutBytes: 3, stderrBytes: 0 },
    createdAt: 1,
    updatedAt: 2,
  };

  it("清单原样透传（不带正文）", async () => {
    const list = vi.fn(async () => [node]);
    const result = await makeGateway(list).workflowRunWorkspace({
      sessionId: "s1",
      runId: "dwfrun-1",
    });
    expect(list).toHaveBeenCalledWith("s1", { runId: "dwfrun-1" });
    expect(result).toEqual({ nodes: [node] });
  });

  it("宿主拒绝（未知 run / 不是你的 run）得到空清单而不是报错——两者不可区分", async () => {
    const result = await makeGateway(async () => undefined).workflowRunWorkspace({
      sessionId: "s1",
      runId: "dwfrun-gone",
    });
    expect(result).toEqual({ nodes: [] });
  });

  it("超过 maxNodes 截尾并置 truncated", async () => {
    const many = Array.from({ length: WORKFLOW_WORKSPACE_LIMITS.maxNodes + 5 }, (_v, i) => ({
      ...node,
      ordinal: i + 1,
    }));
    const result = await makeGateway(async () => many).workflowRunWorkspace({
      sessionId: "s1",
      runId: "dwfrun-1",
    });
    expect(result.nodes).toHaveLength(WORKFLOW_WORKSPACE_LIMITS.maxNodes);
    expect(result.truncated).toBe(true);
  });

  it("能力缺席 → 结构化的能力不支持错误", async () => {
    const run = makeGateway().workflowRunWorkspace({ sessionId: "s1", runId: "dwfrun-1" });
    await expect(run).rejects.toThrow(V4CapabilityUnsupportedError);
  });

  it("冷会话：先把宿主 record 拉起来再读 journal", async () => {
    const calls: string[] = [];
    let registered = false;
    const gateway = new ConversationV4Gateway({
      sessionExists: () => registered,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      listDynamicWorkflowRunWorkspaceNodes: async () => {
        calls.push("list");
        return [node];
      },
      resumePersistedSession: async () => {
        calls.push("resume");
        registered = true;
        return { status: "resumed" };
      },
    });
    await gateway.workflowRunWorkspace({ sessionId: "s1", runId: "dwfrun-1" });
    expect(calls).toEqual(["resume", "list"]);
  });
});

describe("v4 conversation workflowRunNodeResult query", () => {
  function makeGateway(
    readDynamicWorkflowRunNodeResult?: (
      sessionId: string,
      input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
    ) => Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>,
  ) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...(readDynamicWorkflowRunNodeResult ? { readDynamicWorkflowRunNodeResult } : {}),
    });
  }

  const body: DynamicWorkflowRunWorkspaceNodeResult = {
    status: "completed",
    result: { exitCode: 0, stdout: "ok\n", stderr: "" },
    truncated: false,
    totalBytes: 40,
  };

  it("maxBytes 缺省与钳制都在网关：缺省 resultMaxBytes，超过也钳到它", async () => {
    const read = vi.fn(async () => body);
    const gateway = makeGateway(read);
    await gateway.workflowRunNodeResult({
      sessionId: "s1",
      runId: "r",
      siteId: "world-read#1",
      ordinal: 1,
    });
    expect(read).toHaveBeenLastCalledWith("s1", {
      runId: "r",
      siteId: "world-read#1",
      ordinal: 1,
      maxBytes: WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
    });
    await gateway.workflowRunNodeResult({
      sessionId: "s1",
      runId: "r",
      siteId: "world-read#1",
      ordinal: 1,
      maxBytes: 1024,
    });
    expect(read).toHaveBeenLastCalledWith("s1", expect.objectContaining({ maxBytes: 1024 }));
  });

  it("宿主拒绝（无此节点 / 不是你的 run / 不是 world 行）⇒ notFound，三者不可区分", async () => {
    await expect(
      makeGateway(async () => undefined).workflowRunNodeResult({
        sessionId: "s1",
        runId: "r",
        siteId: "ask#1",
        ordinal: 1,
      }),
    ).rejects.toThrow(/fault\.workflowRunNodeResult\.notFound/);
  });

  it("未知参数被 strict schema 拒收；能力缺席是结构化错误", async () => {
    await expect(
      makeGateway(async () => body).workflowRunNodeResult({
        sessionId: "s1",
        runId: "r",
        siteId: "world-read#1",
        ordinal: 1,
        version: 2,
      }),
    ).rejects.toThrow();
    await expect(
      makeGateway().workflowRunNodeResult({
        sessionId: "s1",
        runId: "r",
        siteId: "world-read#1",
        ordinal: 1,
      }),
    ).rejects.toThrow(V4CapabilityUnsupportedError);
  });
});
