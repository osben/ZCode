import { spawn } from "node:child_process";
import {
  DEFAULT_GH_COMMAND_TIMEOUT_MS,
  DEFAULT_GH_DISCOVERY_TIMEOUT_MS,
  DEFAULT_GH_OUTPUT_BYTES,
  getGhBinaryCandidates,
  getGhCommandEnv,
} from "../config.js";

export interface GhCommandExecutionOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  /** GitHub hostname for the request (gh api --hostname); gh defaults to github.com. */
  hostname?: string;
}

export interface GhCommandExecutionResult {
  binaryPath: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface GhCommandProvider {
  resolveGhBinary(): Promise<string | null>;
  run(options: GhCommandExecutionOptions): Promise<GhCommandExecutionResult>;
}

const TIMEOUT_KILL_GRACE_MS = 2_000;

function canExecuteGhCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GH_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function createGhCommandProvider(options?: {
  platform?: NodeJS.Platform;
}): GhCommandProvider {
  const platform = options?.platform ?? process.platform;
  // Binary detection rarely changes within a Host session; cache the first result.
  let cachedGhBinaryPromise: Promise<string | null> | null = null;

  function resolveGhBinary(): Promise<string | null> {
    if (cachedGhBinaryPromise) {
      return cachedGhBinaryPromise;
    }
    const env = getGhCommandEnv();
    cachedGhBinaryPromise = (async () => {
      for (const candidate of getGhBinaryCandidates()) {
        if (await canExecuteGhCandidate(candidate, env)) {
          return candidate;
        }
      }
      return null;
    })();
    return cachedGhBinaryPromise;
  }

  async function run(command: GhCommandExecutionOptions): Promise<GhCommandExecutionResult> {
    const ghBinary = await resolveGhBinary();
    if (!ghBinary) {
      throw new Error("gh binary is not available");
    }
    const binaryPath = ghBinary;

    const args =
      command.hostname && command.hostname !== "github.com"
        ? ["--hostname", command.hostname, ...command.args]
        : command.args;
    const timeoutMs = command.timeoutMs ?? DEFAULT_GH_COMMAND_TIMEOUT_MS;

    return await new Promise<GhCommandExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputTruncated = false;
      let settled = false;

      const child = spawn(binaryPath, args, {
        cwd: command.cwd,
        env: getGhCommandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      function buildResult(exitCode: number | null): GhCommandExecutionResult {
        return {
          binaryPath,
          stdout,
          stderr,
          exitCode,
          timedOut,
        };
      }

      function settle(result: GhCommandExecutionResult): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.removeAllListeners("error");
        child.removeAllListeners("close");
        resolve(result);
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        setTimeout(() => {
          if (!settled) {
            if (platform === "win32" && typeof child.pid === "number") {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
            } else {
              child.kill("SIGKILL");
            }
            setTimeout(() => {
              if (!settled) {
                settle(buildResult(null));
              }
            }, TIMEOUT_KILL_GRACE_MS);
          }
        }, TIMEOUT_KILL_GRACE_MS);
      }, timeoutMs);

      const appendChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
        if (outputTruncated) {
          return;
        }
        const byteLength = chunk.byteLength;
        const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
        if (currentBytes + byteLength > DEFAULT_GH_OUTPUT_BYTES) {
          outputTruncated = true;
          child.kill();
          return;
        }
        const text = chunk.toString("utf-8");
        if (target === "stdout") {
          stdout += text;
          stdoutBytes += byteLength;
        } else {
          stderr += text;
          stderrBytes += byteLength;
        }
      };

      child.once("error", (error) => {
        // Normalize spawn failures to a command result, mirroring the git command provider,
        // so callers handle them through the same exit-code semantics.
        stderr = error instanceof Error ? error.message : String(error);
        settle(buildResult(-2));
      });
      child.stdout?.on("data", (chunk: Buffer) => appendChunk(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => appendChunk(chunk, "stderr"));
      child.once("close", (exitCode) => {
        settle(buildResult(exitCode));
      });
    });
  }

  return { resolveGhBinary, run };
}
