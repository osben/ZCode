import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

// Message fragment the CLI bridge puts in its structured sessionNotFound error for listDynamicWorkflowRuns.
const WORKFLOW_RUNS_SESSION_NOT_FOUND_MESSAGE = "fault.workflowRuns.sessionNotFound";
// Quoted saved-workflows directory as the file-watcher embeds it in its error message: any `.zcode/workflows`
// directory, project-local or user-global (`~/.zcode/workflows`).
const SAVED_WORKFLOWS_DIRECTORY_SUFFIX = /[\\/]\.zcode[\\/]workflows'/;

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

  // The renderer probes the sessions-index subscription with runtimePolicy "existing-only" before the workspace's
  // Agent runtime has started. The Host then throws the runtime-unavailable error by design and the store resubscribes on the
  // runtime "available" lifecycle event, so this failure is expected and must not leave a warning per workspace.
  if (
    message.startsWith("[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
    )
  ) {
    return "info";
  }

  // The Automations > Workflow tabs watch any `.zcode/workflows` directory (<project>/.zcode/workflows or the user-global
  // ~/.zcode/workflows), and most projects and users never create one. The renderer treats that watch failure as normal
  // (useSavedWorkflowsDirectoryWatch, shared by the project and global groups, logs it at debug and catches up on tab
  // change), so only this exact missing-directory failure is lowered; ENOENT on any other path or watch call stays at warn.
  if (
    message.startsWith("[rpc:call] file-watcher.watch FAIL (") &&
    args.some((arg) => isMissingSavedWorkflowsDirectoryError(errorMessageOf(arg)))
  ) {
    return "info";
  }

  // A workflow run list is requested right after a session is created, before the host has registered its record; the
  // CLI rejects it with fault.workflowRuns.sessionNotFound. The renderer requests once per (session, live, refreshKey)
  // and requests again when the session goes live (useWorkflowRunJournalSummaries). Only this RPC's failure is lowered.
  if (
    message.startsWith("[rpc:call] zcode-agent.conversationWorkflowRunsV4 FAIL (") &&
    args.some((arg) => errorMessageOf(arg)?.includes(WORKFLOW_RUNS_SESSION_NOT_FOUND_MESSAGE))
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}

/**
 * The file-watcher wraps the fs error as `无法监视目录 '<path>': ENOENT ... watch '<path>'`, so the quoted path is the only
 * reliable signal across the wrapper. Both POSIX and Windows separators are accepted, for any `.zcode/workflows` directory.
 */
function isMissingSavedWorkflowsDirectoryError(message: string | undefined): boolean {
  return (
    message !== undefined &&
    message.includes("ENOENT") &&
    SAVED_WORKFLOWS_DIRECTORY_SUFFIX.test(message)
  );
}

function errorMessageOf(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null || !("message" in arg)) return undefined;
  const { message } = arg as { message?: unknown };
  return typeof message === "string" ? message : undefined;
}
