import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

export interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Built-in plugin processes managed directly by Host (such as Windows CUA Helper): pid → plugin name. */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

export interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * Host-side responder for the resource manager.
 * Sample once when requested by Main: read the system process list → request MCP child-process mappings from each local Agent → assign ownership by Host subtree → reply.
 * Execute at most one round and do not store a sample queue; after window-close cancellation, do not publish late results.
 */
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => undefined),
      options
        .getAgentService()
        ?.collectLocalRuntimeChildProcesses(signal)
        .catch(() => []) ?? Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    options.postMessage({
      type: HostResponseTypes.ResourceUsageSnapshotResult,
      requestId: message.requestId,
      sampledAt: now(),
      processes,
    });
  }

  return {
    async handleRequest(message) {
      let current: typeof active;
      try {
        // A display timeout in Main does not mean the underlying request ended; do not let per-second polling become an unbounded FIFO.
        if (active) {
          options.postMessage({
            type: HostResponseTypes.ResourceUsageSnapshotResult,
            requestId: message.requestId,
            sampledAt: now(),
            processes: [],
          });
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // If observation fails or replying after shutdown fails, drop only this round; do not affect the Host lifecycle with an unhandled exception.
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
