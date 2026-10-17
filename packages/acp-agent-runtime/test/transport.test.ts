/**
 * Process-tree teardown coverage: the Windows taskkill argument builder and
 * the awaited POSIX group signal.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildWindowsTaskkillArgs, signalProcessTree } from "../src/transport.js";

describe("signalProcessTree", () => {
  it("builds the Windows taskkill tree arguments, forcing only the kill stage", () => {
    expect(buildWindowsTaskkillArgs(42, "SIGTERM")).toEqual(["/pid", "42", "/T"]);
    expect(buildWindowsTaskkillArgs(42, "SIGKILL")).toEqual(["/pid", "42", "/T", "/F"]);
  });

  it.runIf(process.platform !== "win32")(
    "terminates the target process on POSIX through the awaited path",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);",
        ],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
      // The SIGTERM handler must be attached before the signal arrives; the
      // child announces that by writing "ready" once booted.
      await new Promise<void>((resolve) => {
        child.stdout?.once("data", () => resolve());
        child.once("exit", () => resolve());
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      await signalProcessTree(child, "SIGTERM");
      const outcome = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ]);
      expect(outcome).toBe(0);
      // Best-effort reap in case the graceful handler never ran.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
    10_000,
  );
});
