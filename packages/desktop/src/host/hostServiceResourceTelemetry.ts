import { registerHostToolExecResourceTelemetry } from "./hostToolExecResourceTelemetry.js";
import { registerHostMcpResourceTelemetry } from "./hostMcpResourceTelemetry.js";
import type { IDisposable } from "@zcode/rpc";
import { IZCodeAgentService, type ServiceCollection } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { registerHostAgentResourceTelemetry } from "./hostAgentResourceTelemetry.js";
import { registerHostMcpTelemetry } from "./hostMcpTelemetry.js";

interface RegisterHostServiceResourceTelemetryOptions {
  services: Pick<ServiceCollection, "getOptional">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** Standalone Servers must explicitly declare support; local and paired deployments support it by default. */
  telemetrySupported?: boolean;
  /** Hashed runtime environment identity from Host; forwarded only for Main's resource grouping and not sent to ARMS. */
  environmentKey?: string;
  onError?(error: unknown): void;
}

const NO_TELEMETRY: IDisposable = { dispose() {} };

function disposeAll(registrations: IDisposable[]): void {
  while (registrations.length > 0) {
    try {
      registrations.pop()?.dispose();
    } catch {
      // A failure releasing one subscription must not block the others, or listeners will remain when the connection closes.
    }
  }
}

/**
 * Resource telemetry subscriptions for one service collection. Forward CLI resource samples, MCP process-tree samples,
 * Bash slow-command completion facts, and MCP lifecycle telemetry.
 *
 * Call once for local Host services and once per remote workspace connection; the caller supplies `runtimeSurface`:
 * the local CLI is local, and the CLI on a remote zcode-server is remote. Main overrides hardware dimensions reported by samples with global defaults.
 * Subscription lifetime matches the collection; when a remote connection is released, its handle calls `dispose()` so no listeners remain.
 * Multiple dedicated connections to the same remote machine create multiple subscriptions; Main merges the latest CLI/MCP
 * readings by environment and instance, and deduplicates Bash completion facts by completionToken to avoid duplicate counts across connections or windows.
 *
 * Attachments (Desktop renderer / mobile remote control) do not enter here; they reuse a ready collection.
 * These events are restricted to the trusted host relay in Agent connection scope and do not enter the session message surface.
 */
export function registerHostServiceResourceTelemetry(
  options: RegisterHostServiceResourceTelemetryOptions,
): IDisposable {
  // An unknown event on an older Server fails in the peer's asynchronous read loop, which the local try/catch below cannot protect.
  // If the capability is missing, exit before acquiring the service or sending any EventListen request.
  if (options.telemetrySupported === false) {
    return NO_TELEMETRY;
  }
  const agentService = options.services.getOptional(IZCodeAgentService);
  if (!agentService) {
    return NO_TELEMETRY;
  }
  const registrations: IDisposable[] = [];
  try {
    registrations.push(
      registerHostAgentResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostMcpTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
    registrations.push(
      registerHostMcpResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostToolExecResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
  } catch (error) {
    // A telemetry subscription failure must not change Host service initialization or the remote connection result, and must not leave a partial pipeline.
    disposeAll(registrations);
    options.onError?.(error);
    return NO_TELEMETRY;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAll(registrations);
    },
  };
}
