import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingArtifact,
} from "@zcode/shared";

/**
 * Host↔Main browser execution bridge. Host sends a command to Main through parentPort (executed by WebContentsView+CDP)
 * and correlates the returned result by requestId, using the pending-map pattern from createFullFeedbackLogArchiveViaMain.
 *
 * Designed with an injectable postMessage and no global dependencies for unit testing (with a fake parentPort).
 */

export interface BrowserExecuteRequestMessage {
  type: typeof HostResponseTypes.BrowserExecuteRequest;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionContext: "live" | "cached";
  command: BrowserCommand;
}

export interface BrowserExecuteResultMessage {
  requestId: string;
  result: BrowserCommandResult;
}

interface PendingEntry {
  resolve: (result: BrowserCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserCommand["method"];
  startedAt: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  outputPath?: string;
}

/**
 * Host→Main browser subcommand budget. The outer node_repl MCP tool defaults to 60 s; keep 30 s here to leave time for JS
 * cleanup, image normalization, and structured error responses, without allowing the two deadlines to race.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function mayHaveSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "finalize",
    "newTab",
  ].includes(command.method);
}

export interface BrowserControlMainBridge {
  list(): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId?: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: BrowserClientMode;
    sessionContext?: "live" | "cached";
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
  /** Called by Host message dispatch when Main returns a result. */
  handleResult(message: BrowserExecuteResultMessage): Promise<void>;
  dispose(): void;
}

export function createBrowserControlMainBridge(deps: {
  postToMain: (message: BrowserExecuteRequestMessage) => void;
  timeoutMs?: number;
  materializeRecording?(input: {
    artifact: BrowserRecordingArtifact;
    localPath: string;
    outputPath: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<BrowserRecordingArtifact>;
}): BrowserControlMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browserId = `iab:${randomUUID()}`;
  const browserGeneration = Date.now();
  const deletePendingIfCurrent = (requestId: string, entry: PendingEntry): boolean => {
    if (pending.get(requestId) !== entry) return false;
    pending.delete(requestId);
    return true;
  };
  const descriptor: BrowserBackendDescriptor = {
    id: browserId,
    generation: browserGeneration,
    type: "iab",
    name: "ZCode In-app Browser",
    capabilities: {
      // Capability collection lists optional capabilities only; tabs/cua/screenshot/dialog are core APIs
      // and must not be presented as capabilities. viewport is a core Playwright-like Tab API; the browser capability
      // currently exposes only visibility, and unimplemented pageAssets/cdp are not exposed.
      browser: [
        {
          id: "visibility",
          description:
            "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
        },
      ],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tabs.finalize": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "BrowserRecordingAPI.start": true,
      "BrowserRecordingAPI.status": true,
      "BrowserRecordingAPI.cancel": true,
    },
    metadata: {
      provider: "zcode-desktop-iab",
    },
  };

  return {
    async list(): Promise<BrowserBackendDescriptor[]> {
      return [descriptor];
    },

    async execute({
      requestId: inputRequestId,
      browserId: requestedBrowserId,
      browserGeneration: requestedBrowserGeneration,
      sessionId,
      turnId,
      workspaceKey = sessionId,
      workspacePath = workspaceKey,
      workspaceIdentity,
      remoteSessionId,
      clientMode = "desktop-continuous",
      sessionContext = "live",
      command,
    }): Promise<BrowserCommandResult> {
      if (requestedBrowserId && requestedBrowserId !== browserId) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${requestedBrowserId}' is no longer available`,
          },
          elapsedMs: 0,
        };
      }
      if (
        requestedBrowserGeneration !== undefined &&
        requestedBrowserGeneration !== browserGeneration
      ) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${browserId}' generation ${requestedBrowserGeneration} is stale`,
          },
          elapsedMs: 0,
        };
      }
      const requestId = inputRequestId ?? randomUUID();
      if (pending.has(requestId)) {
        // requestId correlates the result with its Promise. Replacing an entry with the same key
        // would deliver an old result to a new Promise and let the old timer/finally delete the new request. Fail before transport.
        return {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      const startedAt = Date.now();
      // Set the transport budget for fixed waits to request duration + 2 seconds to cover the wait and transport overhead.
      // Otherwise, waitForTimeout(>=30s) may be misclassified as a Host bridge timeout before its timer completes normally.
      const requestTimeoutMs =
        command.method === "playwrightWaitForTimeout"
          ? command.timeoutMs + 2_000
          : command.method === "playwright"
            ? ("timeoutMs" in command.action
                ? (command.action.timeoutMs ?? timeoutMs)
                : timeoutMs) + 2_000
            : timeoutMs;
      return await new Promise<BrowserCommandResult>((resolve) => {
        let entry: PendingEntry;
        const timer = setTimeout(() => {
          // Allow only the current entry to settle its own lifecycle. This prevents a future same-key replacement path
          // from letting an old timer delete or cancel a later request.
          if (!deletePendingIfCurrent(requestId, entry)) return;
          // Previously, Host ended only the local wait while the action continued in Main/backend, even though the caller
          // had already received a timeout. Send a reverse cancel using the same scope. When dispatch cannot be confirmed,
          // mark the result uncertain under the operation-result contract; do not report a timeout as having no side effects.
          const cancelRequestId = randomUUID();
          try {
            deps.postToMain({
              type: HostResponseTypes.BrowserExecuteRequest,
              requestId: cancelRequestId,
              browserId,
              browserGeneration,
              sessionId,
              turnId,
              workspaceKey,
              workspacePath,
              workspaceIdentity,
              remoteSessionId,
              clientMode,
              sessionContext,
              command: { method: "cancelRequest", requestId },
            });
          } catch {
            // The original request has already timed out; a failed cancel transport must not replace the more useful timeout result.
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `browser 命令 ${command.method} 超时（${requestTimeoutMs}ms）`,
              sideEffect: mayHaveSideEffects(command) ? "uncertain" : "none",
            },
            elapsedMs: Date.now() - startedAt,
          });
        }, requestTimeoutMs);
        entry = {
          resolve,
          timer,
          method: command.method,
          startedAt,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(command.method === "recordingStatus" && command.outputPath
            ? { outputPath: command.outputPath }
            : {}),
        };
        pending.set(requestId, entry);
        try {
          deps.postToMain({
            type: HostResponseTypes.BrowserExecuteRequest,
            requestId,
            browserId,
            browserGeneration,
            sessionId,
            turnId,
            workspaceKey,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            clientMode,
            sessionContext,
            command,
          });
        } catch (error) {
          clearTimeout(timer);
          deletePendingIfCurrent(requestId, entry);
          resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
    },

    async handleResult(message): Promise<void> {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // Late result (already cleaned up after timeout); ignore it.
        return;
      }
      clearTimeout(entry.timer);
      if (!deletePendingIfCurrent(message.requestId, entry)) return;
      const artifact = message.result.recording?.artifact;
      if (
        message.result.ok &&
        message.result.recording?.status === "completed" &&
        artifact &&
        entry.outputPath
      ) {
        if (!deps.materializeRecording) {
          entry.resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser recording artifact materialization is unavailable",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
          return;
        }
        try {
          const materialized = await deps.materializeRecording({
            artifact,
            localPath: artifact.path,
            outputPath: entry.outputPath,
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
            ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
          });
          entry.resolve({
            ...message.result,
            recording: { ...message.result.recording, artifact: materialized },
          });
        } catch (error) {
          entry.resolve({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
        }
        return;
      }
      if (message.result.recording?.status === "completed" && artifact && !entry.outputPath) {
        const { artifact: _mainTemporaryArtifact, ...recording } = message.result.recording;
        entry.resolve({
          ...message.result,
          recording,
        });
        return;
      }
      entry.resolve(message.result);
    },

    dispose(): void {
      for (const [requestId, entry] of pending) {
        if (!deletePendingIfCurrent(requestId, entry)) continue;
        clearTimeout(entry.timer);
        // Clearing the map directly would leave every awaited call hanging forever. Bridge shutdown must
        // settle the promises and explicitly mark whether backend execution is indeterminate.
        entry.resolve({
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser bridge disposed while command was pending",
            sideEffect: "uncertain",
          },
          elapsedMs: Date.now() - entry.startedAt,
        });
      }
    },
  };
}
