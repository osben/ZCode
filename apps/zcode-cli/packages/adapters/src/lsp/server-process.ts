import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Logger, LanguageServerKey, ResolvedLspServer } from "@zcode/contracts";
import type { ResolvedSpawnCommand } from "../exec/execution-command.js";
import { terminateMcpStdioProcessTree } from "../mcp/process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "../mcp/windows-job-object.js";
import { LSP_STDERR_TAIL_MAX_CHARS } from "./constants.js";
import type { LspWorkspaceFolder } from "./client-capabilities.js";
import { JsonRpcFramingError } from "./json-rpc.js";
import { LspJsonRpcConnection } from "./json-rpc-connection.js";
import { handleServerRequest, LspDynamicRegistry } from "./server-requests.js";

export type LspSpawnFn = (
  file: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export const defaultLspSpawn: LspSpawnFn = (file, args, options) => spawn(file, args, options);

export interface LspServerProcessEvents {
  /** Spawn failed before a pid existed (ENOENT, EACCES, ...). */
  onSpawnError(process: LspServerProcess, error: NodeJS.ErrnoException): void;
  onExit(process: LspServerProcess, code: number | null, signal: NodeJS.Signals | null): void;
  onProtocolError(process: LspServerProcess, error: JsonRpcFramingError): void;
}

export interface LspServerProcessInput {
  server: ResolvedLspServer;
  key: LanguageServerKey;
  command: ResolvedSpawnCommand;
  env: Record<string, string>;
  platform: NodeJS.Platform;
  spawnImpl: LspSpawnFn;
  logger: Logger;
  settings: unknown;
  workspaceFolders: LspWorkspaceFolder[];
  startedAt: number;
  events: LspServerProcessEvents;
}

/**
 * One child process plus its JSON-RPC pipe. It reports exits and framing errors through `events` and
 * never decides lifecycle policy itself; `server-lifecycle.ts` does.
 */
export class LspServerProcess {
  readonly server: ResolvedLspServer;
  readonly key: LanguageServerKey;
  readonly child: ChildProcessWithoutNullStreams;
  readonly startedAt: number;
  readonly registry = new LspDynamicRegistry();
  readonly rpc: LspJsonRpcConnection;
  initializeCapabilities: Record<string, unknown> = {};
  initialized = false;
  exited = false;
  /** Set once the lifecycle has decided this process is finished (stop, failure, or crash). */
  stopRequested = false;
  stderrTail = "";
  windowsJob: WindowsJobObjectController | undefined;

  private readonly platform: NodeJS.Platform;
  private readonly exitWaiter: Promise<void>;
  private resolveExit: () => void = () => undefined;

  constructor(input: LspServerProcessInput) {
    this.server = input.server;
    this.key = input.key;
    this.startedAt = input.startedAt;
    this.platform = input.platform;
    this.child = input.spawnImpl(input.command.file, input.command.args, {
      cwd: input.key.workspacePath,
      env: input.env,
      shell: false,
      windowsHide: true,
    });
    this.rpc = new LspJsonRpcConnection({
      serverId: input.server.id,
      stdin: this.child.stdin,
      stdout: this.child.stdout,
      logger: input.logger,
      handleServerRequest: (method, params) =>
        handleServerRequest(
          {
            settings: input.settings,
            workspaceFolders: input.workspaceFolders,
            registry: this.registry,
          },
          method,
          params,
        ),
      onProtocolError: (error) => input.events.onProtocolError(this, error),
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = appendStderrTail(this.stderrTail, chunk.toString("utf8"));
    });
    this.exitWaiter = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.child.once("exit", () => this.markExited());
    this.child.once("error", (error: NodeJS.ErrnoException) => {
      if (this.child.pid === undefined) {
        // A spawn that never produced a pid emits no `exit`; mark it finished so waiters do not hang.
        this.markExited();
        input.events.onSpawnError(this, error);
      }
    });
    this.child.once("exit", (code, signal) => input.events.onExit(this, code, signal));
    if (this.child.pid !== undefined && this.platform === "win32") {
      void attachProcessToWindowsJobObject(this.child.pid, { platform: this.platform }).then(
        (job) => {
          if (this.exited || this.stopRequested) {
            job?.close();
          } else {
            this.windowsJob = job;
          }
        },
      );
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves true when the process exited within `timeoutMs`. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.exited), timeoutMs);
      void this.exitWaiter.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Kills the whole tree: the Windows job first, then the POSIX/taskkill tree walker as fallback. */
  async terminate(): Promise<void> {
    const job = this.windowsJob;
    this.windowsJob = undefined;
    if (job) {
      try {
        job.terminate();
      } finally {
        job.close();
      }
    }
    if (this.exited || this.child.pid === undefined) return;
    await terminateMcpStdioProcessTree(this.child.pid, { platform: this.platform });
  }

  private markExited(): void {
    this.exited = true;
    this.resolveExit();
  }
}

export function appendStderrTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > LSP_STDERR_TAIL_MAX_CHARS
    ? combined.slice(combined.length - LSP_STDERR_TAIL_MAX_CHARS)
    : combined;
}
