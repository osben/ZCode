import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@zcode/shared";

export function registerHostToolExecResourceTelemetry(options: {
  agentService: Pick<IZCodeAgentService, "onDynamicToolExecResource">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}): IDisposable {
  return options.agentService.onDynamicToolExecResource()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.ToolExecResource,
        runtimeSurface: options.runtimeSurface,
        sample,
      });
    } catch {
      // If Main exits or the channel closes, drop only the current completion fact; do not affect the Bash lifecycle.
    }
  });
}
