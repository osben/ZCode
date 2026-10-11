import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

interface ZCodeStdioTransportOptions {
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

const STDIO_EOF_EXIT_WAIT_MS = 1_800;
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
const PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS = 250;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  // Chunks of the current unfinished line; joined only when an LF arrives (see the handleStdoutData comment).
  private stdoutPendingChunks: string[] = [];
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio frames use LF as the only delimiter. Node readline treats U+2028/U+2029
    // as line breaks, so model text containing these characters would split a valid JSON string into partial frames.
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    child.once("exit", (code, signal) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // On Windows and POSIX, the agent wrapper may spawn runtime/MCP subprocesses;
      // killing only the parent would leave descendants running or briefly lock the workspace cwd.
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // stdin EOF may cause the CLI root process to exit before detached MCP processes.
    // Save the process-tree members before sending EOF, or after the root exits and the system adopts its descendants, they cannot be recovered by PPID.
    this.cleanupAttemptCount += 1;
    const cleanupStartedAtMs = Date.now();
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    // Deducting only forceAfterMs cannot constrain slow CIM; after force reaches 0, the waiter could still
    // receive another taskkill + exit grace period. On Windows, fix the same absolute deadline from cleanup start
    // through the snapshot, EOF, and waiter to reliably stay within the Host's 3.5 s service phase.
    const windowsCleanupDeadlineAtMs =
      process.platform === "win32"
        ? cleanupStartedAtMs +
          forceBudgetMs +
          PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS +
          PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS
        : undefined;
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot(
      windowsCleanupDeadlineAtMs,
    );
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // The normal exit boundary for app-server --stdio is stdin EOF. Directly taskkilling
      // the process tree would skip the agent's own shutdown and make the Host wait for the full force-kill fallback window.
      // Request a graceful shutdown through the protocol first; if it does not respond promptly, use the process-tree fallback while still ensuring no subprocesses remain.
      this.requestStdioClose();
      // The unminified coverage CLI bundle includes full source maps and starts/exits noticeably more slowly than the release package.
      // Keep the extra write grace period under coverage; ordinary windows use the CLI's 1500 ms exit deadline.
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
      const remainingCleanupMs =
        windowsCleanupDeadlineAtMs === undefined
          ? configuredEofWaitMs
          : Math.max(windowsCleanupDeadlineAtMs - Date.now(), 0);
      await this.waitForChildExit(Math.min(configuredEofWaitMs, remainingCleanupMs));
    }
    // When the app closes, the Host must wait for the process-tree SIGTERM/SIGKILL fallback to finish;
    // even if the root child exited during the EOF window, reclaim descendants using the previously saved snapshot.
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // The absolute deadline for Windows wait cleanup is the remaining force interval + taskkill cap + exit grace period.
      // Cap the command at 1 s so the full cleanup still fits within the Host's 3.5 s service phase.
      windowsTaskkillTimeoutMs: PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      // If the previous cleanup reported leftovers, the final app-quit retry must not wait through the full
      // graceful window; go directly to force so it stays within the exit budget Main gives the Host.
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    // After Windows taskkill confirms the OS process has exited, Node's ChildProcess exit event
    // may arrive one turn later. The waiter already checks PID liveness and identity; adding the root PID again using stale
    // exitCode/signalCode here could report successful cleanup as a leftover and trigger a useless retry.
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain(
      windowsCleanupDeadlineAtMs === undefined
        ? undefined
        : Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, windowsCleanupDeadlineAtMs - Date.now())),
    );
    if (remainingPids.length > 0) {
      // If cleanup is treated as successful after only logging a warning, the manager immediately releases ownership
      // and app quit cannot handle the leftover again. Treat leftovers as failure and retain the snapshot for the final retry.
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    // Cause: the old implementation did `stdoutBuffer += chunk` and then indexOf("\n") over the
    // whole buffer, so every 64KB chunk made V8 flatten the cons string and rescan from the start,
    // giving O(n²) total cost for a single-line frame of length n. A task-index-resync session/read
    // returns a full snapshot of about 15MB on one line; measured over 30s, real stdout of 95MB
    // caused 9.4GB of flattened allocations, Host CPU at 100%, and RSS spiking to 1.5–1.9GB.
    // Fix: search for LF only within the new chunk, keep unfinished parts in a chunk array, and
    // join once when the frame completes — linear cost.
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.consumeStdoutText(text);
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutPendingChunks.push(this.stdoutDecoder.end());
    const trailing = this.stdoutPendingChunks.join("");
    this.stdoutPendingChunks = [];
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

  private consumeStdoutText(text: string): void {
    let start = 0;
    let newlineIndex = text.indexOf("\n", start);
    while (newlineIndex >= 0) {
      this.stdoutPendingChunks.push(text.slice(start, newlineIndex));
      const frame = this.stdoutPendingChunks.join("");
      this.stdoutPendingChunks = [];
      start = newlineIndex + 1;
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = text.indexOf("\n", start);
    }
    if (start < text.length) {
      this.stdoutPendingChunks.push(text.slice(start));
    }
  }

  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // Protocol frame dispatch used to synchronously query the system process list, blocking the
      // Host event loop during telemetry/streaming peaks and leaving the subagent panel without output. The runtime data plane now only parses and forwards;
      // full process-tree queries are restricted to the dispose cleanup boundary.
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // After a remote WSL/SSH agent exits immediately, the Host may still be writing an unfinished protocol request.
    // Node's stdin write callback rejects, but the underlying Socket also emits an error event; without a persistent listener,
    // zcode-server could crash on an unhandled EPIPE, and the UI would see only a remote disconnection instead of a protocol request failure.
    // Treat a stream error as a closed transport and prevent further writes to the failed agent.
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // The agent may exit during disposeAndWait, causing an EOF request to fail after stdin is half-closed;
      // this failure must not interrupt the process-tree fallback, or the shutdown path could leave runtime processes behind.
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async captureCleanupSnapshot(
    windowsCleanupDeadlineAtMs?: number,
  ): Promise<ProcessTreeSnapshot | undefined> {
    const childHadExited = this.hasChildExited();
    const liveTree = childHadExited
      ? undefined
      : await captureProcessTreeSnapshotAsync(this.child, {
          log: processTreeLogger,
          ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
          ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
          // The root may exit while WMIC/CIM is querying. Its exit time is unknown when the query starts;
          // read the exit event recorded after the same query completes to safely recover old descendants and rule out PID reuse.
          resolveOwnedProcessExitedAtMs: () => this.childExitedAtMs,
        });
    if (liveTree) {
      return liveTree;
    }
    if (process.platform === "win32" && !childHadExited && this.child.pid) {
      // Do not serialize a second query after failure; descendants of a root that exited normally during the query have already been restored
      // by captureProcessTreeSnapshotAsync using that query's process list and root lifecycle. Explicitly preserve "identity unverifiable" here,
      // or empty identities could be mistaken for a process tree that has exited.
      return {
        rootPid: this.child.pid,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      };
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) {
      return captureProcessGroupSnapshot(processGroupId);
    }
    const exitedTree = await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
    if (exitedTree) {
      return exitedTree;
    }
    // After an asynchronous CIM query fails on Windows, do not query again immediately inside terminateAndWait;
    // the two timeouts would add serially and consume Main's entire shutdown budget. Continue observing the original ChildProcess with an unverifiable snapshot,
    // and report a leftover explicitly on timeout, but never signal an unverified reused PID.
    return process.platform === "win32" && this.child.pid
      ? {
          rootPid: this.child.pid,
          descendantPids: [],
          identities: [],
          identityVerification: "unavailable",
        }
      : undefined;
  }
}
