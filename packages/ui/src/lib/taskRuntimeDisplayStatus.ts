import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isLiveTaskRuntimeStatus(status: ZCodeTaskRuntimeStatus | undefined): boolean {
  // Bugfix: restoring is only historical recovery, not the agent executing a new round of
  // generation. History lists and the mobile remote-control home show running/loading only when
  // the current runtime is explicitly creating or streaming.
  return status === "creating" || status === "streaming";
}
