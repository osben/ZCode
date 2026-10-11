import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostAgentResourceTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicProcessResourceSample">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}

/**
 * Host forwarding for CLI resource samples.
 *
 * Host only passes samples through: services assigns the lane based on the owning process manager when parsing protocol notifications.
 * New fields such as heap / uptime / machine memory / instanceToken are passed to Main as-is,
 * which determines role ownership and aggregation. Host performs no statistics and owns no windows.
 */
export function registerHostAgentResourceTelemetry(
  options: RegisterHostAgentResourceTelemetryOptions,
): IDisposable {
  return options.agentService.onDynamicProcessResourceSample()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        sample,
      });
    } catch {
      // If Main has exited or IPC is unavailable, drop only the current sample; do not affect Agent service notification delivery.
    }
  });
}
