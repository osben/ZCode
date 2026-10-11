import { logger } from "@/logger.js";
import type { ConversationTransport } from "@/v4/transport.js";

type FrameListener = Parameters<ConversationTransport["onFrame"]>[0];
type AssemblyFaultListener = Parameters<ConversationTransport["onAssemblyFault"]>[0];
type RuntimeRestartListener = Parameters<ConversationTransport["onRuntimeRestart"]>[0];
type RuntimeLifecycleListener = Parameters<
  NonNullable<ConversationTransport["onRuntimeLifecycle"]>
>[0];

async function unsubscribeIgnoringFailure(
  transport: ConversationTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    logger.warn(
      `[v4-conversation] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Keep the renderer-side transport identity stable while a remote service proxy is replaced.
 *
 * Existing panes in the same workspace continue holding this object; after replace, commands and subscriptions are forwarded to
 * the latest proxy, and listeners on the old proxy are synchronously removed first to prevent old and new Stores from competing for the same topic ownership.
 */
export class ReplaceableConversationTransport implements ConversationTransport {
  private readonly frameListeners = new Set<FrameListener>();
  private readonly assemblyFaultListeners = new Set<AssemblyFaultListener>();
  private readonly runtimeRestartListeners = new Set<RuntimeRestartListener>();
  private readonly runtimeLifecycleListeners = new Set<RuntimeLifecycleListener>();
  private readonly transportBySubscriptionId = new Map<string, ConversationTransport>();
  private offFrame: (() => void) | null = null;
  private offAssemblyFault: (() => void) | null = null;
  private offRuntimeRestart: (() => void) | null = null;
  private offRuntimeLifecycle: (() => void) | null = null;

  /**
   * This method is removed during construction if the underlying service does not support runtime lifecycle; consumers then fall back to onRuntimeRestart.
   * Capability is determined by the current service at construction time: subsequent transports for the same workspace all come from
   * createAgentConversationTransport, so support depends only on agentService and does not change during replacement.
   */
  onRuntimeLifecycle?: (listener: RuntimeLifecycleListener) => () => void = (listener) => {
    this.runtimeLifecycleListeners.add(listener);
    this.bindRuntimeLifecycleListener();
    return () => {
      this.runtimeLifecycleListeners.delete(listener);
      if (this.runtimeLifecycleListeners.size === 0) {
        this.offRuntimeLifecycle?.();
        this.offRuntimeLifecycle = null;
      }
    };
  };

  constructor(private current: ConversationTransport) {
    if (!current.onRuntimeLifecycle) {
      this.onRuntimeLifecycle = undefined;
    }
  }

  replace(transport: ConversationTransport): void {
    if (transport === this.current) return;

    const previous = this.current;
    this.detachCurrentListeners();
    // Release active subscriptions on the old proxy first, but a disconnected RPC may remain
    // pending forever; cleanup is best-effort and must not block the new proxy from taking over subscriptions.
    for (const [subscriptionId, owner] of this.transportBySubscriptionId) {
      if (owner !== previous) continue;
      this.transportBySubscriptionId.delete(subscriptionId);
      void unsubscribeIgnoringFailure(previous, subscriptionId);
    }

    this.current = transport;
    this.bindCurrentListeners();
    // Replacing a proxy invalidates only connection ownership; the CLI runtime/logEpoch may remain continuous.
    // Pass the reason explicitly so the Store can fresh-subscribe at its current watermark and let the server decide resume/snapshot.
    for (const listener of this.runtimeRestartListeners) listener("transportReplaced");
  }

  async subscribe(
    params: Parameters<ConversationTransport["subscribe"]>[0],
  ): ReturnType<ConversationTransport["subscribe"]> {
    const owner = this.current;
    const result = await owner.subscribe(params);
    if (owner !== this.current) {
      // A late ACK from before replacement must not rewrite the stable transport's ownership map.
      void unsubscribeIgnoringFailure(owner, result.ack.subscriptionId);
      throw new Error("fault.subscription.transportReplaced");
    }
    this.transportBySubscriptionId.set(result.ack.subscriptionId, owner);
    return result;
  }

  activate(subscriptionId: string): void {
    (this.transportBySubscriptionId.get(subscriptionId) ?? this.current).activate(subscriptionId);
  }

  resync(
    params: Parameters<ConversationTransport["resync"]>[0],
  ): ReturnType<ConversationTransport["resync"]> {
    return (this.transportBySubscriptionId.get(params.subscriptionId) ?? this.current).resync(
      params,
    );
  }

  unsubscribe(subscriptionId: string): ReturnType<ConversationTransport["unsubscribe"]> {
    const owner = this.transportBySubscriptionId.get(subscriptionId) ?? this.current;
    this.transportBySubscriptionId.delete(subscriptionId);
    return owner.unsubscribe(subscriptionId);
  }

  sendCommand(
    envelope: Parameters<ConversationTransport["sendCommand"]>[0],
  ): ReturnType<ConversationTransport["sendCommand"]> {
    return this.current.sendCommand(envelope);
  }

  queryCommands(
    params: Parameters<ConversationTransport["queryCommands"]>[0],
  ): ReturnType<ConversationTransport["queryCommands"]> {
    return this.current.queryCommands(params);
  }

  rowsRange(
    params: Parameters<ConversationTransport["rowsRange"]>[0],
  ): ReturnType<ConversationTransport["rowsRange"]> {
    return this.current.rowsRange(params);
  }

  plans(
    params: Parameters<ConversationTransport["plans"]>[0],
  ): ReturnType<ConversationTransport["plans"]> {
    return this.current.plans(params);
  }

  // workflowRunEvents was added later to ConversationTransport (as an RPC for workflow-run event logs),
  // but only concrete transport implementations received it, leaving this stable identity without forwarding. Panes hold this object,
  // so `transport.workflowRunEvents` was undefined in panes using a service proxy — the event log on the run detail page
  // was silently disconnected and opening it threw. Add a forwarding method here whenever the interface gains a member.
  workflowRunEvents(
    params: Parameters<ConversationTransport["workflowRunEvents"]>[0],
  ): ReturnType<ConversationTransport["workflowRunEvents"]> {
    return this.current.workflowRunEvents(params);
  }

  // Prevent the same omission: add forwarding here whenever the interface gains a member.
  workflowRuns(
    params: Parameters<ConversationTransport["workflowRuns"]>[0],
  ): ReturnType<ConversationTransport["workflowRuns"]> {
    return this.current.workflowRuns(params);
  }

  // Forward all three read interfaces for workflow user-facing artifacts here; otherwise the service proxy method is
  // undefined and the side pane call throws.
  workflowRunArtifacts(
    params: Parameters<ConversationTransport["workflowRunArtifacts"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifacts"]> {
    return this.current.workflowRunArtifacts(params);
  }

  workflowRunArtifactData(
    params: Parameters<ConversationTransport["workflowRunArtifactData"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactData"]> {
    return this.current.workflowRunArtifactData(params);
  }

  workflowRunArtifactRead(
    params: Parameters<ConversationTransport["workflowRunArtifactRead"]>[0],
  ): ReturnType<ConversationTransport["workflowRunArtifactRead"]> {
    return this.current.workflowRunArtifactRead(params);
  }

  // Two read interfaces for the dwf script transcript.
  workflowRunWorkspace(
    params: Parameters<ConversationTransport["workflowRunWorkspace"]>[0],
  ): ReturnType<ConversationTransport["workflowRunWorkspace"]> {
    return this.current.workflowRunWorkspace(params);
  }

  workflowRunNodeResult(
    params: Parameters<ConversationTransport["workflowRunNodeResult"]>[0],
  ): ReturnType<ConversationTransport["workflowRunNodeResult"]> {
    return this.current.workflowRunNodeResult(params);
  }

  fileChanges(
    params: Parameters<ConversationTransport["fileChanges"]>[0],
  ): ReturnType<ConversationTransport["fileChanges"]> {
    return this.current.fileChanges(params);
  }

  fileRewindPreview(
    params: Parameters<ConversationTransport["fileRewindPreview"]>[0],
  ): ReturnType<ConversationTransport["fileRewindPreview"]> {
    return this.current.fileRewindPreview(params);
  }

  attachmentPut(
    params: Parameters<ConversationTransport["attachmentPut"]>[0],
    options?: Parameters<ConversationTransport["attachmentPut"]>[1],
  ): ReturnType<ConversationTransport["attachmentPut"]> {
    return this.current.attachmentPut(params, options);
  }

  attachmentRead(
    params: Parameters<ConversationTransport["attachmentRead"]>[0],
  ): ReturnType<ConversationTransport["attachmentRead"]> {
    return this.current.attachmentRead(params);
  }

  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]> {
    return this.current.attachmentReadRange(params);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    this.bindFrameListener();
    return () => {
      this.frameListeners.delete(listener);
      if (this.frameListeners.size === 0) {
        this.offFrame?.();
        this.offFrame = null;
      }
    };
  }

  onAssemblyFault(listener: AssemblyFaultListener): () => void {
    this.assemblyFaultListeners.add(listener);
    this.bindAssemblyFaultListener();
    return () => {
      this.assemblyFaultListeners.delete(listener);
      if (this.assemblyFaultListeners.size === 0) {
        this.offAssemblyFault?.();
        this.offAssemblyFault = null;
      }
    };
  }

  onRuntimeRestart(listener: RuntimeRestartListener): () => void {
    this.runtimeRestartListeners.add(listener);
    this.bindRuntimeRestartListener();
    return () => {
      this.runtimeRestartListeners.delete(listener);
      if (this.runtimeRestartListeners.size === 0) {
        this.offRuntimeRestart?.();
        this.offRuntimeRestart = null;
      }
    };
  }

  private bindCurrentListeners(): void {
    this.bindFrameListener();
    this.bindAssemblyFaultListener();
    this.bindRuntimeRestartListener();
    this.bindRuntimeLifecycleListener();
  }

  private bindFrameListener(): void {
    if (this.offFrame || this.frameListeners.size === 0) return;
    this.offFrame = this.current.onFrame((frame, context) => {
      for (const listener of this.frameListeners) listener(frame, context);
    });
  }

  private bindAssemblyFaultListener(): void {
    if (this.offAssemblyFault || this.assemblyFaultListeners.size === 0) return;
    this.offAssemblyFault = this.current.onAssemblyFault((fault) => {
      for (const listener of this.assemblyFaultListeners) listener(fault);
    });
  }

  private bindRuntimeRestartListener(): void {
    if (this.offRuntimeRestart || this.runtimeRestartListeners.size === 0) return;
    const owner = this.current;
    this.offRuntimeRestart = owner.onRuntimeRestart(() => {
      for (const [subscriptionId, subscriptionOwner] of this.transportBySubscriptionId) {
        if (subscriptionOwner === owner) {
          this.transportBySubscriptionId.delete(subscriptionId);
        }
      }
      for (const listener of this.runtimeRestartListeners) listener();
    });
  }

  private bindRuntimeLifecycleListener(): void {
    if (this.offRuntimeLifecycle || this.runtimeLifecycleListeners.size === 0) return;
    this.offRuntimeLifecycle =
      this.current.onRuntimeLifecycle?.((state) => {
        for (const listener of this.runtimeLifecycleListeners) listener(state);
      }) ?? null;
  }

  private detachCurrentListeners(): void {
    this.offFrame?.();
    this.offFrame = null;
    this.offAssemblyFault?.();
    this.offAssemblyFault = null;
    this.offRuntimeRestart?.();
    this.offRuntimeRestart = null;
    this.offRuntimeLifecycle?.();
    this.offRuntimeLifecycle = null;
  }
}
