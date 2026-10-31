import type { WindowHostAttachmentScope } from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

export interface WindowHostAttachmentPort {
  once(event: "close", listener: () => void): unknown;
}

/**
 * Why an attachment is disposed. `host-shutdown` means the Host is tearing down and will
 * dispose the services behind every attachment right after (specs/host-shutdown-teardown-logging.md).
 */
export type WindowHostAttachmentDisposeReason = "host-shutdown";

export interface WindowHostAttachmentHandle {
  dispose(reason?: WindowHostAttachmentDisposeReason): void;
}

type WindowHostAttachmentFlowState = "saturated" | "drained" | "closed";

export interface WindowHostAttachmentFlowScope {
  setTransportFlowState(state: WindowHostAttachmentFlowState): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Serializes one attachment's transport flow edges into its connection scope; close is
 * ordered after every edge already received, so a late "saturated" never revives CLI pause state.
 */
export function createWindowHostAttachmentFlowForwarder(
  scope: WindowHostAttachmentFlowScope | undefined,
  onForwardError: (state: WindowHostAttachmentFlowState, error: unknown) => void,
) {
  let chain = Promise.resolve();
  let hostShutdown = false;
  const forward = (state: WindowHostAttachmentFlowState): Promise<void> => {
    if (!scope) return Promise.resolve();
    const update = chain.then(() => scope.setTransportFlowState(state));
    chain = update.catch((error: unknown) => {
      // An edge still queued when host shutdown begins is rejected by the agent disposal that
      // follows; that cancellation is not a recoverable fault.
      if (!hostShutdown) onForwardError(state, error);
    });
    return update;
  };
  return {
    forward,
    close(reason?: WindowHostAttachmentDisposeReason): Promise<void> {
      if (!scope) return Promise.resolve();
      if (reason === "host-shutdown") {
        hostShutdown = true;
        // The Host disposes the agent right after the attachments, which rejects an in-flight
        // "closed" RPC with "ZCode Protocol client disposed" (ISSUE-061). scope.dispose() still
        // enqueues "closed" itself as silent best effort; only the reported forward is skipped.
        return chain.then(() => scope.dispose());
      }
      return forward("closed")
        .catch(() => {})
        .then(() => scope.dispose());
    },
  };
}

export interface WindowHostResolvedAttachmentScope<TServices, TCapabilities = never> {
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
}

export interface WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities = never> {
  requestId: string;
  attachmentId: string;
  clientMode: ZCodeAgentV4ClientMode;
  terminalOwnerId?: string;
  scope: WindowHostAttachmentScope;
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
  port: TPort;
}

interface TrackedAttachment<TServices, TPort, TCapabilities = never> {
  params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>;
  handle: WindowHostAttachmentHandle;
  disposed: boolean;
}

export function createWindowHostAttachmentRegistry<
  TServices,
  TPort extends WindowHostAttachmentPort,
  TCapabilities = never,
>(options: {
  resolveScope: (
    scope: WindowHostAttachmentScope,
  ) => WindowHostResolvedAttachmentScope<TServices, TCapabilities>;
  expose: (
    params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>,
  ) => WindowHostAttachmentHandle;
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  function disposeTracked(
    tracked: TrackedAttachment<TServices, TPort, TCapabilities>,
    reason?: WindowHostAttachmentDisposeReason,
  ): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose(reason);
  }

  function attach(params: {
    requestId: string;
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    terminalOwnerId?: string;
    scope: WindowHostAttachmentScope;
    port: TPort;
  }): void {
    if (params.clientMode === "web-remote-replayable" && params.scope.kind === "source-settings") {
      throw new Error("Source settings attachments are Desktop-only");
    }
    // scope 必须先由 Host registry 验证；验证失败时不能影响同 attachmentId 的现有端口。
    const resolved = options.resolveScope(params.scope);
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      ...params,
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    };
    const handle = options.expose(exposedParams);
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    const previous = attachments.get(params.attachmentId);
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
    disposeTracked(tracked);
  }

  function detachStaleRemoteSessionAttachments(
    remoteSessionId: string,
    currentGeneration: number,
  ): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId ||
        tracked.params.generation === currentGeneration
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachRemoteSessionAttachments(remoteSessionId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachSourceSettingsAttachments(sourceServerId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "source-settings" ||
        tracked.params.scope.sourceServerId !== sourceServerId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  return {
    attach,
    detach,
    detachRemoteSessionAttachments,
    detachSourceSettingsAttachments,
    detachStaleRemoteSessionAttachments,
    size: () => attachments.size,
    list: () =>
      Array.from(attachments.values(), (tracked) => ({
        requestId: tracked.params.requestId,
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        generation: tracked.params.generation,
      })),
    /** Host shutdown only: every handle learns that its services are disposed next. */
    dispose(): void {
      for (const tracked of attachments.values()) {
        disposeTracked(tracked, "host-shutdown");
      }
      attachments.clear();
    },
  };
}
