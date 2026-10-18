import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

/**
 * Host previously logged all RPC messages at error, making the main log look as if every RPC had failed.
 * Apply minimal message-based levels here: FAIL is warn, frequent polling successes are debug, and everything else is info.
 */
export function resolveRpcLogLevel(message: string, ...args: unknown[]): RpcLogLevel {
  // Background details are read once per second and success logs would continuously hit disk; lower the success level for this query only and retain failure diagnostics.
  if (message.startsWith("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (")) return "debug";

  // Every Desktop composer polls the dictation model state about once per second to drive the microphone
  // status dot; successes would flood the production log, failures stay at warn.
  if (message.startsWith("[rpc:call] voice-dictation.getRuntimeState OK (")) return "debug";

  // On first workspace binding, provider registry syncs after the runtime identity query.
  // This failure with an explicit error code is a startup handshake state, not service degradation; avoid leaving a warning for every workspace.
  if (
    message.includes("zcode-session.getWorkspaceRuntimeIdentity FAIL") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    )
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}
