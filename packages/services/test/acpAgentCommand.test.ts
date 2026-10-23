import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { killCommandTree } from "../src/model-provider/acpAgentCommand.js";

// specs/acp-agent-runtime.md "Processes": on Windows the direct child is killed only when taskkill cannot finish the
// tree kill (it fails to start or exits non-zero); killing the child while taskkill enumerates lets grandchildren live.

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    kill: vi.fn(() => true),
  });
  return child;
}

function injectedSpawner() {
  const killers: EventEmitter[] = [];
  const spawn = vi.fn(() => {
    const killer = new EventEmitter();
    killers.push(killer);
    return killer as unknown as ChildProcess;
  });
  return { spawn, killers };
}

describe("killCommandTree on Windows", () => {
  it("keeps the direct child alive while taskkill is still enumerating", () => {
    const child = fakeChild();
    const { spawn, killers } = injectedSpawner();

    killCommandTree(child as unknown as ChildProcess, { platform: "win32", spawn: spawn as never });

    expect(spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4321", "/T", "/F"],
      expect.any(Object),
    );
    expect(child.kill).not.toHaveBeenCalled();
    killers[0]!.emit("exit", 0, null);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills the direct child when taskkill fails to start", () => {
    const child = fakeChild();
    const { spawn, killers } = injectedSpawner();

    killCommandTree(child as unknown as ChildProcess, { platform: "win32", spawn: spawn as never });
    killers[0]!.emit("error", new Error("spawn taskkill ENOENT"));

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills the direct child when taskkill exits non-zero", () => {
    const child = fakeChild();
    const { spawn, killers } = injectedSpawner();

    killCommandTree(child as unknown as ChildProcess, { platform: "win32", spawn: spawn as never });
    killers[0]!.emit("exit", 1, null);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("never kills the direct child twice when taskkill both errors and reports an exit", () => {
    const child = fakeChild();
    const { spawn, killers } = injectedSpawner();

    killCommandTree(child as unknown as ChildProcess, { platform: "win32", spawn: spawn as never });
    killers[0]!.emit("error", new Error("boom"));
    killers[0]!.emit("exit", null, null);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
