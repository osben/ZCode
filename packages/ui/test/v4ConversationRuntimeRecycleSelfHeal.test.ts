// CUA Helper cold-start readiness recycles the agent runtime; an already-open conversation panel must self-heal.
//
// Live/dev reproduction timeline (2026-08-22 dev log):
//   17:26:41.5  user opens an existing conversation → subscribeConversationV4 in flight (agent still warming up)
//   17:26:44.395 [cua-product-helper] cua helper ready
//                → reconcileRecoveredHelper → recycleUntilStable → disposeWorkspace
//   17:26:44.719 the in-flight subscribe is interrupted by transport.onClose's rejectAll:
//                Error: ZCode agent transport closed
//   17:26:44.96  ZCode agent process exited terminationReason='workspace-dispose'
//
// Before the fix, two defects in the store left the panel stuck forever (SessionPane's errored branch replaces
// the whole pane with red text plus a reconnect button):
//   1. The constructor unconditionally subscribed only to onRuntimeRestart. But transport.ts already states:
//      on dispose, only onRuntimeLifecycle's unavailable is observable; onRuntimeRestart fires only after the
//      new process spawns. The agent is lazily started — if the user only reads history and sends no message it
//      never spawns, so the generation-change signal never arrives.
//   2. connect()'s catch freezes status="error" for everything except initialFrameStagingOverflow,
//      with no bounded backoff like sessionsIndexStore has.
//
// Prerequisite for self-heal to work (zcodeAgentService.ts:5581): subscribeConversationV4 goes through
// getReadOnlyClient(params), which defaults to start-if-needed, so resubscribing itself pulls the agent up —
// the deliberate policy contrast with the sidebar's subscribeSessionsIndexV4, which explicitly uses
// existing-only + dormant, is intentional design.
import { Emitter } from "@zcode/rpc";
import type { ConversationTopicWireFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  type IZCodeAgentService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";

const TOPIC = "conversation/s1";
const WORKSPACE_PATH = "/repo";

type LifecycleEvent = {
  workspaceKey: string;
  workspacePath: string;
  runtimeIdentity: { generation: number; identity: string; workspaceKey: string };
  state: "available" | "unavailable";
};

/** The unavailable branch of connectionScope must read runtimeIdentity.generation to invalidate the local owner. */
function lifecycleEvent(state: "available" | "unavailable", generation: number): LifecycleEvent {
  return {
    workspaceKey: WORKSPACE_PATH,
    workspacePath: WORKSPACE_PATH,
    runtimeIdentity: {
      generation,
      identity: `runtime-${generation}`,
      workspaceKey: WORKSPACE_PATH,
    },
    state,
  };
}

/** The exact message ZCodeProtocolClient.rejectAll throws when a workspace-dispose interrupts an in-flight subscribe. */
const TRANSPORT_CLOSED = "ZCode agent transport closed";

/** Same length as the implementation's RUNTIME_RECYCLE_RETRY_DELAYS_MS (250/1000/3000ms). */
const RUNTIME_RECYCLE_RETRY_ATTEMPTS = 3;

function setupBase(options: { withLifecycle?: boolean } = {}) {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const runtimeLifecycle = new Emitter<LifecycleEvent>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  /** Each subscribe consumes one error in order; once exhausted, ACKs normally. */
  const pendingFailures: Error[] = [];
  const mocks = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => {
      const failure = pendingFailures.shift();
      if (failure) throw failure;
      return {
        ack: {
          subscriptionId: nextId(params),
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      };
    }),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume" as const,
        logEpoch: "epoch-1",
      },
    })),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    setConnectionFlowStateV4: vi.fn(async () => {}),
    ...(options.withLifecycle
      ? {
          onAgentRuntimeLifecycle: vi.fn((listener: (event: LifecycleEvent) => void) =>
            runtimeLifecycle.event(listener),
          ),
        }
      : {}),
  };
  return {
    base: mocks as unknown as IZCodeAgentService,
    mocks,
    runtimeLifecycle,
    runtimeRestarts,
    pendingFailures,
  };
}

function createStore(
  base: IZCodeAgentService,
  connectionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
) {
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId,
    clientMode,
  });
  const transport = createAgentConversationTransport(scope.service, {
    workspacePath: WORKSPACE_PATH,
  });
  return { transport, store: new ConversationProjectionStore(TOPIC, transport) };
}

describe("conversation projection 在 CUA Helper 回收 agent runtime 后自愈", () => {
  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s 冷订阅期间收到 restart，过期 ACK 后自动重新订阅",
    async (clientMode) => {
      vi.useFakeTimers();
      try {
        const { base, mocks, runtimeLifecycle, runtimeRestarts } = setupBase({
          withLifecycle: true,
        });
        const { store } = createStore(base, "cold-restart", clientMode);
        mocks.subscribeConversationV4.mockImplementationOnce(async () => {
          runtimeRestarts.fire({ workspaceKey: WORKSPACE_PATH });
          runtimeLifecycle.fire(lifecycleEvent("available", 2));
          return { ack: { subscriptionId: "stale", mode: "snapshot", logEpoch: "epoch-1" } };
        });
        await store.connect();
        expect(store.getState().status).toBe("connecting");
        await vi.advanceTimersByTimeAsync(250);
        expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
        expect(store.getState().status).toBe("live");
        expect(store.getState().lastError).toBeNull();
        expect(mocks.unsubscribeConversationV4).not.toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionId: "stale" }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("runtime available 到达时重新订阅（transport 暴露 lifecycle 时不能只依赖 onRuntimeRestart）", async () => {
    const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
    const { transport, store } = createStore(base, "conn-lifecycle");
    expect(transport.onRuntimeLifecycle).toBeTypeOf("function");

    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // workspace-dispose in the moment: the only observable signal. The new runtime does not exist yet, so no resubscribe.
    runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
    await Promise.resolve();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // New runtime ready: must resubscribe automatically, otherwise the panel stays stuck on the old subscription/error state forever.
    runtimeLifecycle.fire(lifecycleEvent("available", 2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  it("首次 subscribe 在途时 runtime available 不应再开第二条订阅", async () => {
    const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
    let resolveSubscribe:
      | ((value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void)
      | null = null;
    mocks.subscribeConversationV4.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const { store } = createStore(base, "conn-initial-available");

    const connectPromise = store.connect();
    await vi.waitFor(() => expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1));

    // On cold start the agent spawn broadcasts available first; while the first subscribe is still in flight,
    // that notification must not push the same pane through another round of connect, or the stale ACK is
    // unsubscribed immediately.
    runtimeLifecycle.fire(lifecycleEvent("available", 1));
    await Promise.resolve();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    resolveSubscribe?.({
      ack: { subscriptionId: "sub-initial-available", mode: "snapshot", logEpoch: "epoch-1" },
    });
    await connectPromise;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-initial-available");
  });

  it("live 订阅被回收且 available 永不到达时，退避重连自行拉起 runtime", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
      const { store } = createStore(base, "conn-dormant");

      await store.connect();
      expect(store.getState().status).toBe("live");

      // Send only unavailable, never available — exactly the real lazy-start situation: after dispose nobody
      // pulls the agent up, so neither onRuntimeRestart nor available ever arrives. With only dormant here,
      // the panel would spin forever.
      runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

      // Resubscribe goes through start-if-needed, which itself pulls the runtime up.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression protection (not TDD-driven; the implementation was already correct): the backoff must be bounded,
  // and once exhausted the failure must surface as error so SessionPane's errored branch renders the
  // "Reconnect" button.
  it("退避耗尽后落 error 暴露「重新连接」入口", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, runtimeLifecycle, pendingFailures } = setupBase({
        withLifecycle: true,
      });
      const { store } = createStore(base, "conn-exhausted");

      await store.connect();
      expect(store.getState().status).toBe("live");

      for (let i = 0; i < 8; i += 1) pendingFailures.push(new Error(TRANSPORT_CLOSED));
      runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).toContain(TRANSPORT_CLOSED);
      expect(mocks.subscribeConversationV4.mock.calls.length).toBeLessThanOrEqual(
        1 + RUNTIME_RECYCLE_RETRY_ATTEMPTS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runtime 反复回收（连续 unavailable）耗尽退避后落 error，不静默停在 connecting", async () => {
    vi.useFakeTimers();
    try {
      const { base, runtimeLifecycle } = setupBase({ withLifecycle: true });
      const { store } = createStore(base, "conn-flapping");

      await store.connect();
      expect(store.getState().status).toBe("live");

      // When the Helper crashes repeatedly / liveness repeatedly declares it dead, unavailable arrives in a row with
      // no available in between, each one consuming one unit of backoff budget. If the final attempt only clears
      // state without landing in error, the panel spins forever.
      for (let i = 0; i < RUNTIME_RECYCLE_RETRY_ATTEMPTS + 1; i += 1) {
        runtimeLifecycle.fire(lifecycleEvent("unavailable", i + 2));
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // CR-01 regression: a remote workspace's proxy generation change only goes through onRuntimeRestart("transportReplaced");
  // ReplaceableConversationTransport.replace() fires no lifecycle events. If the store, in lifecycle mode, gave up the
  // restart channel entirely, nobody would receive this notification — replace() already unsubscribes from the old
  // proxy on a best-effort basis, but the store would stay live with the old subscriptionId, and the frame stream
  // would silently break with no self-heal.
  it("lifecycle 模式下仍接收 proxy 换代（transportReplaced），携原水位重订阅", async () => {
    const { base, mocks } = setupBase({ withLifecycle: true });
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-proxy-1",
      clientMode: "desktop-continuous",
    });
    const replaceable = new ReplaceableConversationTransport(
      createAgentConversationTransport(scope.service, { workspacePath: WORKSPACE_PATH }),
    );
    // The real shape of the remote registry: the underlying transport supports lifecycle, so Replaceable exposes it too.
    expect(replaceable.onRuntimeLifecycle).toBeTypeOf("function");
    const store = new ConversationProjectionStore(TOPIC, replaceable);

    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // activateRemoteService() → replace(): the new proxy takes over and the old subscription has been unsubscribed.
    const nextScope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-proxy-2",
      clientMode: "desktop-continuous",
    });
    replaceable.replace(
      createAgentConversationTransport(nextScope.service, { workspacePath: WORKSPACE_PATH }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  // The dual constraint of CR-01: after adding the restart channel back, a single runtime generation change must not
  // be handled once by each of the two channels (that would create a wasted subscription and pull the runtime up twice).
  // The discriminator is reason — the direct transport forwards with "runtimeRestart", Replaceable forwards the
  // underlying transport with undefined; both must be filtered out, and only "transportReplaced" passes.
  it("runtime 换代同时到达两条通道时只重订阅一次", async () => {
    const { base, mocks, runtimeLifecycle, runtimeRestarts } = setupBase({ withLifecycle: true });
    const { store } = createStore(base, "conn-no-double");

    await store.connect();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // A real runtime generation change: available and onAgentRuntimeRestarted arrive at the same instant.
    runtimeRestarts.fire({ workspaceKey: WORKSPACE_PATH });
    runtimeLifecycle.fire(lifecycleEvent("available", 2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  it("在途 subscribe 被 workspace-dispose 打断后有界退避重连，不定格 error", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, pendingFailures } = setupBase();
      pendingFailures.push(new Error(TRANSPORT_CLOSED));
      const { store } = createStore(base, "conn-retry");

      await store.connect();
      // Before the fix: status was already "error" + lastError="ZCode agent transport closed" here,
      // with no timer at all — from then on the panel could only be recovered by the user clicking "Reconnect".
      expect(store.getState().status).not.toBe("error");
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

      // Within the backoff window it resubscribes automatically and returns to live.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
      expect(store.getState().lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
