// Mechanism-level reproduction and fix verification of the fault.subscription.notOwned wire
// race (three incidents in zcode-logs-full-20260730-204321).
//
// Race timeline (renderer ⇄ host is an async link; windows reach hundreds of ms on a remote SSH
// workspace):
//
//   renderer(store/transport)          host(connectionScope)             CLI(base)
//   ──────────────────────────         ─────────────────────             ─────────
//   connect() → subscribe ────────────▶ remember(S1) ◀──────────────────  ACK S1
//   [S1 live]
//   connect() generation-bump resubscribe ──subscribe(S2) in flight──▶ …
//   S1 online frames gap
//     → resync(S1) passes the local
//       ownership check, RPC in flight ─────▶ …
//   sendCommand ──────────────────────▶ validation passes ─────────────▶  success
//                                       remember(S2): same ownershipKey
//                                       silently evicts S1 (no unsubscribe sent,
//                                       no runtime restart) ◀──────────  ACK S2
//   [S2 live]
//   the late resync(S1) arrives ──────▶ findBySubscription cannot find S1
//                                       → rejects fault.subscription.notOwned
//
// Before the fix the store wrote this late failure as status="error" with no auto-reconnect
// (the session stayed stuck forever, requiring a manual reconnect). The fixed behavior has two
// layers, matching this file's two positive tests:
//   1. when connect()'s generation bump succeeds, the old subscription recovery created inside
//      the await window is discarded — the late notOwned belongs to a recovery flow already
//      dropped by the generation bump, so it is silently ignored and S2 stays live;
//   2. if notOwned hits a recovery that "still belongs to the current subscription" (e.g. an
//      ownership divergence caused by a misordered unsubscribe), the store self-heals with a
//      fresh subscribe at the current watermark and does not land in error.
import { Emitter } from "@zcode/rpc";
import type { LocalTtftFacts } from "@zcode/shared";
import type {
  ConversationTopicFrame,
  ConversationTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  type IZCodeAgentService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";

const TOPIC = "conversation/s1";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── CLI base mock: provides only the minimal behavior the conversation surface needs ──
function setupBase() {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const localTtftFacts = new Emitter<LocalTtftFacts>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  const mocks = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => ({
      ack: {
        subscriptionId: nextId(params),
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
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
    // transport.onFrame also mounts a local TTFT checkpoint emitter (only on desktop-continuous
    // local workspaces); base must provide that dynamic Event, otherwise connectionScope's
    // forwarding throws immediately.
    onDynamicLocalTtftFacts: vi.fn(() => localTtftFacts.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    setConnectionFlowStateV4: vi.fn(async () => {}),
  };
  return {
    base: mocks as unknown as IZCodeAgentService,
    mocks,
    conversationFrames,
  };
}

// ── RPC latency gate: simulates in-flight requests on the renderer→host link (latency that really exists over remote SSH) ──
function createRpcGate(service: IZCodeAgentService) {
  const holding = new Set<string>();
  const held = new Map<string, Array<() => void>>();
  const proxy = new Proxy(service as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = String(property);
      return (...args: unknown[]) => {
        if (!holding.has(method)) return (value as (...a: unknown[]) => unknown)(...args);
        return new Promise((resolve, reject) => {
          const queue = held.get(method) ?? [];
          queue.push(() => {
            Promise.resolve()
              .then(() => (value as (...a: unknown[]) => unknown)(...args))
              .then(resolve, reject);
          });
          held.set(method, queue);
        });
      };
    },
  }) as unknown as IZCodeAgentService;
  return {
    service: proxy,
    hold(method: string) {
      holding.add(method);
    },
    heldCount(method: string) {
      return held.get(method)?.length ?? 0;
    },
    async release(method: string) {
      holding.delete(method);
      const queue = held.get(method) ?? [];
      held.delete(method);
      for (const run of queue) run();
      await flush();
    },
  };
}

function onlineDeltasWire(
  subscriptionId: string,
  ordinal: number,
  fromSeq: number,
  toSeq: number,
): ConversationTopicWireFrame {
  const frame: ConversationTopicFrame = {
    topic: TOPIC,
    subscriptionId,
    fromSeq,
    toSeq,
    sentAt: 1,
    payload: { kind: "deltas", deltas: [] },
  };
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `logical-${subscriptionId}-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: TOPIC,
    subscriptionId,
    frame,
  };
}

describe("v4 resync notOwned eviction race（真实 store + transport + connectionScope）", () => {
  it("换代 subscribe ACK 静默驱逐旧 ownership 后，迟到 resync 的 notOwned 被静默忽略，S2 保持 live", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    // 1) First connect succeeds: S1 goes live (the initial frame has not arrived yet, appliedBase=false — matching the wire's remote link).
    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-1");

    // 2) The UI bumps the generation and resubscribes (real triggers: retry(), resume initial
    //    gap forcing a snapshot, initialFrameStagingOverflow auto-retry, etc.); subscribe(S2) is
    //    in flight on the renderer→host link.
    gate.hold("subscribeConversationV4");
    const reconnect = store.connect();
    await flush();
    expect(gate.heldCount("subscribeConversationV4")).toBe(1);

    // 3) Inside the race window S1 receives an online delta (initial missing → same-sub
    //    recovery): resync(S1) has already passed the transport's local ownership check, and the
    //    RPC is in flight too.
    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-1-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // 3.5) A command in the same window succeeds as usual — matching the wire log "sendCommand
    //      worked before resync failed", proving connection and handshake are healthy and
    //      ruling out disconnect/restart factors.
    const ack = await transport.sendCommand(
      createCommandEnvelope({ type: "sendText", payload: { text: "hi" }, sessionId: "s1" }),
    );
    expect(ack.status).toBe("accepted");

    // 4) subscribe(S2)'s ACK reaches the host first: remember() evicts S1 silently under the
    //    same ownershipKey (conversation, workspace, topic, connectionId) — no unsubscribe is
    //    sent to the CLI and there is no runtime restart.
    await gate.release("subscribeConversationV4");
    await reconnect;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-2");
    expect(mocks.unsubscribeConversationV4).not.toHaveBeenCalled();

    // 5) The late resync(S1) only now arrives at the host scope → fault.subscription.notOwned.
    await gate.release("resyncConversationV4");
    await flush();

    // Post-fix shape: the scope still rejects (the request never reached the CLI), but the
    // store already discarded S1's recovery when the generation bump succeeded, so the late
    // failure is silently ignored — S2 stays live, no error, and no extra resubscribe.
    expect(mocks.resyncConversationV4).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-1-2");
    expect(store.getState().lastError).toBeNull();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);

    offFrame();
  });

  it("错位 unsubscribe 造成 ownership 分歧时，resync notOwned 自动携水位重订阅自愈", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-3",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    await store.connect();
    expect(store.getState().subscriptionId).toBe("sub-conn-3-1");

    // The gap triggers same-sub recovery: resync(S1) is in flight on the renderer→host link.
    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-3-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // Misordered unsubscribe: another caller holding the same connection (a doubly mounted data
    // layer / a stale view instance) unsubscribes S1 directly at the scope. The transport's
    // local map does not know — the wire log's "unsubscribe → resync notOwned" sequence is
    // exactly this shape.
    await scope.service.unsubscribeConversationV4({
      workspacePath: "/repo",
      subscriptionId: "sub-conn-3-1",
    });

    // The late resync(S1) arrives → notOwned. After the fix the store does not land in error;
    // it self-heals with a fresh subscribe at the current watermark (the server decides
    // resume/snapshot).
    await gate.release("resyncConversationV4");
    await vi.waitFor(() => {
      expect(store.getState().subscriptionId).toBe("sub-conn-3-2");
    });
    expect(store.getState().status).toBe("live");
    expect(store.getState().lastError).toBeNull();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);

    offFrame();
  });

  it("对照：resync(S1) 先于 subscribe(S2) ACK 抵达 host 时不触发 notOwned", async () => {
    const { base, mocks, conversationFrames } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    const gate = createRpcGate(scope.service);
    const transport = createAgentConversationTransport(gate.service, {
      workspacePath: "/repo",
    });
    const store = new ConversationProjectionStore(TOPIC, transport);
    const offFrame = transport.onFrame((frame, context) => store.handleFrame(frame, context));

    await store.connect();
    expect(store.getState().subscriptionId).toBe("sub-conn-2-1");

    gate.hold("subscribeConversationV4");
    const reconnect = store.connect();
    await flush();

    gate.hold("resyncConversationV4");
    conversationFrames.fire(onlineDeltasWire("sub-conn-2-1", 1, 7, 8));
    await flush();
    expect(gate.heldCount("resyncConversationV4")).toBe(1);

    // The only difference: the arrival order is swapped — resync(S1) lands first, while the scope still holds S1's ownership.
    await gate.release("resyncConversationV4");
    expect(mocks.resyncConversationV4).toHaveBeenCalledTimes(1);
    expect(store.getState().status).not.toBe("error");

    await gate.release("subscribeConversationV4");
    await reconnect;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-conn-2-2");
    expect(store.getState().lastError).toBeNull();

    offFrame();
  });
});
