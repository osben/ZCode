import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv } from "@zcode/acp-agent-runtime";
import { createServiceLogger } from "../logger/serviceLogger.js";

/** Caps the output of a status command; the status timeout bounds its runtime (specs/acp-agent-runtime.md). */
const MAX_STATUS_OUTPUT_CHARS = 16 * 1024;
export const STATUS_TIMEOUT_MS = 10_000;

const log = createServiceLogger("acp-agent");

/** Runs a short non-interactive command with output caps; the status and tree-kill helpers stay here. */
export function defaultRunCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const suffix = timedOut ? `\n[timed out after ${timeoutMs}ms]` : "";
      resolve({ exitCode, output: `${output.trim()}${suffix}`.trim() });
    };
    const append = (chunk: string): void => {
      if (output.length >= MAX_STATUS_OUTPUT_CHARS) return;
      output += chunk;
      if (output.length > MAX_STATUS_OUTPUT_CHARS)
        output = output.slice(0, MAX_STATUS_OUTPUT_CHARS);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        // Same scrubbed environment as the ACP session process.
        env: buildChildEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(undefined, "ACP status command failed to spawn", { error: message });
      resolve({ exitCode: null, output: message });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      // Descendants may inherit the pipes and keep them open after the direct
      // child dies; terminate the tree and settle now instead of waiting for
      // a `close` that may never come.
      killCommandTree(child);
      finish(null);
    }, timeoutMs);
    // String decoding via setEncoding keeps a multibyte character that is
    // split across two chunks intact (per-chunk toString would corrupt it).
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error: Error) => {
      log.warn(undefined, "ACP status command failed", { error: error.message });
      append(error.message);
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

/** Platform and spawner of the tree kill; injectable for tests. */
export interface KillCommandTreeDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
}

/**
 * Best-effort termination of a command and its descendants (non-blocking). On Windows the direct child is killed
 * only when taskkill cannot finish the tree kill (it fails to start, or exits non-zero): killing the child while
 * taskkill is still enumerating would leave its grandchildren running.
 */
export function killCommandTree(child: ChildProcess, deps: KillCommandTreeDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawn ?? spawn;
  const pid = child.pid;
  const killDirectChild = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  if (platform === "win32" && pid !== undefined) {
    let fallbackUsed = false;
    const fallback = (reason: string, error?: Error): void => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      log.warn(undefined, "ACP status command tree kill failed; killing the direct child", {
        reason,
        ...(error ? { error: error.message } : {}),
      });
      killDirectChild();
    };
    try {
      const killer = spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2_000,
      });
      killer.once("error", (error: Error) => fallback("error", error));
      killer.once("exit", (code: number | null) => {
        if (code !== 0) fallback(`exit ${String(code)}`);
      });
    } catch (error) {
      fallback("spawn", error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Not a group leader (spawn failed before detaching).
    }
  }
  killDirectChild();
}
