import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  fork: vi.fn(),
  isServiceManagerAvailable: vi.fn(async () => true),
  registerService: vi.fn(async () => {
    throw new Error("service manager unavailable");
  }),
  unregisterService: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: serviceMocks.fork,
}));

vi.mock("../src/platform/serviceManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/serviceManager.js")>()),
  isServiceManagerAvailable: serviceMocks.isServiceManagerAvailable,
  registerService: serviceMocks.registerService,
  unregisterService: serviceMocks.unregisterService,
}));

import { runServerCli } from "../src/cli.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { createServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveCanonicalServerLayout, resolveServerLayout } from "../src/runtime/paths.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { Supervisor } from "../src/supervisor/supervisor.js";

async function writeStatusSnapshot(statusFile: string, status: unknown): Promise<void> {
  // Bug cause: writeFile(status.json) truncates before writing, so waitForServerStopped could read
  // invalid JSON in the intermediate state. Use the same temporary-file + rename atomic replacement
  // as the production status persister so tests do not fabricate corruption production never produces.
  const temporary = `${statusFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.test.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, statusFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const retryDelay = [25, 50, 100, 200, 400][attempt];
        if (
          retryDelay === undefined ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

describe("daemon service registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts a detached daemon when the OS user service manager is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-fallback-"));
    const layout = resolveServerLayout(join(root, "server"));
    const output: string[] = [];
    await mkdir(layout.runDir, { recursive: true });
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    serviceMocks.isServiceManagerAvailable.mockResolvedValueOnce(false);
    serviceMocks.fork.mockImplementationOnce(() => {
      setTimeout(() => void writeStatusSnapshot(layout.statusFile, readyStatus), 0);
      return {
        unref: vi.fn(),
        disconnect: vi.fn(),
        once: vi.fn(),
      };
    });

    const exit = await runServerCli(
      ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
      { stdout: { write: (value) => output.push(value) } },
    );

    expect(exit, output.join("")).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      state: "ready",
      serviceRegistered: false,
    });
    expect(serviceMocks.registerService).not.toHaveBeenCalled();
    expect(serviceMocks.fork).toHaveBeenCalledOnce();
  });

  it("falls back detached with the registration reason when the service load fails", async () => {
    // Load-stage failures (daemon-reload/enable) start no unit in this run, so the CLI may fall
    // back detached; the reason must travel to the caller instead of failing the whole serve.
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-load-fallback-"));
    const layout = resolveServerLayout(join(root, "server"));
    await mkdir(layout.runDir, { recursive: true });
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    serviceMocks.registerService.mockImplementationOnce(async () => {
      throw Object.assign(new Error("systemctl --user enable failed: unit is not readable"), {
        stage: "load",
      });
    });
    serviceMocks.fork.mockImplementationOnce(() => {
      setTimeout(() => void writeStatusSnapshot(layout.statusFile, readyStatus), 0);
      return {
        unref: vi.fn(),
        disconnect: vi.fn(),
        once: vi.fn(),
      };
    });
    const output: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");

    const exit = await runServerCli(
      ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
      { stdout: { write: (value) => output.push(value) } },
    );

    expect(exit, output.join("")).toBe(0);
    expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    expect(serviceMocks.fork).toHaveBeenCalledOnce();
    const result = JSON.parse(output.at(-1) ?? "{}");
    expect(result).toMatchObject({ state: "ready", serviceRegistered: false });
    expect(result.serviceFallbackReason).toBe(
      "systemctl --user enable failed: unit is not readable",
    );
    await rm(root, { recursive: true, force: true });
  });

  it("warns on stderr when a load failure falls back detached in foreground mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-load-warn-"));
    const layout = resolveServerLayout(join(root, "server"));
    await mkdir(layout.runDir, { recursive: true });
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    serviceMocks.registerService.mockImplementationOnce(async () => {
      throw Object.assign(new Error("systemctl --user enable failed: unit is not readable"), {
        stage: "load",
      });
    });
    serviceMocks.fork.mockImplementationOnce(() => {
      setTimeout(() => void writeStatusSnapshot(layout.statusFile, readyStatus), 0);
      return {
        unref: vi.fn(),
        disconnect: vi.fn(),
        once: vi.fn(),
      };
    });
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");

    const exit = await runServerCli(["serve", "--daemon", "--server-root", layout.serverRoot], {
      stderr: { write: (value) => errors.push(value) },
    });

    expect(exit).toBe(0);
    expect(errors.join("")).toContain(
      "Starting ZCode Server in detached fallback mode: systemctl --user enable failed: unit is not readable",
    );
    expect(serviceMocks.fork).toHaveBeenCalledOnce();
    await rm(root, { recursive: true, force: true });
  });

  it("returns registration failure without starting a fallback when the failure is not a load failure", async () => {
    // Start-stage failures mean the unit is already enabled; silently starting a detached
    // daemon would race it, so the CLI must still fail with the registration error.
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-registration-"));
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");
    serviceMocks.registerService.mockImplementationOnce(async () => {
      throw Object.assign(new Error("systemctl --user start failed: exit 1"), {
        stage: "start",
      });
    });

    const exit = await runServerCli(["serve", "--daemon", "--server-root", join(root, "server")], {
      stderr: { write: (value) => errors.push(value) },
    });

    expect(exit).toBe(1);
    expect(errors.join("")).toContain("systemctl --user start failed: exit 1");
    expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    expect(serviceMocks.fork).not.toHaveBeenCalled();
  });

  it("stops and unregisters a same-root legacy service before registering the root-scoped identity", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zdr-"));
    const layout = resolveServerLayout(join(root, "server"));
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    const kind =
      platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler";
    const legacyDescriptor = createServiceDescriptor({
      platform,
      command: join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode"),
      args: ["serve", "--supervisor", "--server-root", layout.serverRoot],
    });
    await mkdir(layout.serviceDir, { recursive: true });
    await writeFile(join(layout.serviceDir, `${kind}.service`), legacyDescriptor.content, "utf8");
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: true,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    const commands: string[] = [];
    let stopCompleted: Promise<void> = Promise.resolve();
    const fallbackLock = new DataRootLock(layout.lockFile);
    await fallbackLock.acquire();
    let lockAtRegistration: Awaited<ReturnType<DataRootLock["inspect"]>> | undefined;
    serviceMocks.registerService.mockImplementationOnce(async () => {
      lockAtRegistration = await new DataRootLock(layout.lockFile).inspect();
      throw new Error("service manager unavailable");
    });
    await writeStatusSnapshot(layout.statusFile, {
      ...readyStatus,
      state: "stopped",
      pid: null,
      updatedAt: readyStatus.updatedAt,
    });
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "status") return readyStatus;
      if (request.command === "stop") {
        // Fix reason: the old fixture wrote status fire-and-forget, so the rename could still run
        // after test teardown, causing an unhandled EPERM on Windows and leaving the CLI waiting
        // for the lock release. Explicitly own the full stop lifecycle.
        stopCompleted = new Promise((resolve) => setTimeout(resolve, 100)).then(async () => {
          await writeStatusSnapshot(layout.statusFile, {
            ...readyStatus,
            state: "stopped",
            pid: null,
            updatedAt: Date.now() + 1,
          });
          await fallbackLock.release();
        });
        return { stopping: true };
      }
      throw new Error(`Unexpected command: ${request.command}`);
    });
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");
    try {
      const exit = await runServerCli(["serve", "--daemon", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toContain("service manager unavailable");
      expect(commands).toEqual(["status", "stop"]);
      const canonicalLayout = await resolveCanonicalServerLayout(layout.serverRoot);
      expect(serviceMocks.unregisterService).toHaveBeenCalledWith(
        expect.objectContaining({ name: "com.zhipu.zcode.server" }),
        join(canonicalLayout.serviceDir, `${kind}.service`),
      );
      expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    } finally {
      await stopCompleted;
      await control.close();
      await fallbackLock.release();
    }
    expect(lockAtRegistration?.state).toMatch(/missing|stale/);
  });

  it("closes a stop-failed Supervisor whose Core already exited before starting a replacement", async () => {
    // Bug 原因：stop-failed 的 Supervisor 在迟到 exit 后仍持有锁与 control socket，旧实现直接拉起
    // 新 Supervisor，只能锁冲突失败；设备在有人手工 stop 前一直无法重新连接。
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zsf-"));
    const layout = resolveServerLayout(join(root, "server"));
    const core = Object.assign(new EventEmitter(), {
      pid: 42,
      send: () => true,
      kill: () => {
        setTimeout(() => core.emit("exit", null, "SIGKILL"), 50);
        return true;
      },
    });
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          queueMicrotask(() =>
            core.emit("message", {
              type: "ready",
              host: "127.0.0.1",
              port: 43123,
              version: "test",
              generation,
            }),
          );
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreStopGraceTimeoutMs: 5,
      coreKillTimeoutMs: 5,
    });
    try {
      await supervisor.start();
      await vi.waitFor(() => expect(supervisor.status().state).toBe("ready"));
      await expect(supervisor.stop()).rejects.toThrow(/did not terminate after SIGKILL/);
      await vi.waitFor(() =>
        expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: null }),
      );

      let supervisorStateAtFork: string | undefined;
      serviceMocks.isServiceManagerAvailable.mockResolvedValueOnce(false);
      serviceMocks.fork.mockImplementationOnce(() => {
        supervisorStateAtFork = supervisor.status().state;
        setTimeout(
          () =>
            void writeStatusSnapshot(layout.statusFile, {
              ...supervisor.status(),
              state: "ready",
              pid: 43,
              port: 43124,
              host: "127.0.0.1",
              updatedAt: Date.now() + 1,
            }),
          0,
        );
        return { unref: vi.fn(), disconnect: vi.fn(), once: vi.fn() };
      });
      const output: string[] = [];
      const exit = await runServerCli(
        ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      );

      expect(exit, output.join("")).toBe(0);
      expect(supervisorStateAtFork).toBe("stopped");
      expect(serviceMocks.fork).toHaveBeenCalledOnce();
      await expect(new DataRootLock(layout.lockFile).inspect()).resolves.toEqual({
        state: "missing",
      });
    } finally {
      await supervisor.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the daemon startup timeout with the persisted state and last exit reason", async () => {
    // The Supervisor writes the Core failure reason into status.json; the CLI timeout error must
    // carry it instead of a bare "Timed out waiting for Server ready".
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-timeout-"));
    const layout = resolveServerLayout(join(root, "server"));
    await mkdir(layout.runDir, { recursive: true });
    serviceMocks.fork.mockImplementationOnce(() => {
      setTimeout(
        () =>
          void writeStatusSnapshot(layout.statusFile, {
            protocolVersion: 1 as const,
            state: "starting" as const,
            pid: 42,
            port: null,
            host: null,
            version: "test",
            generation: 1,
            startedAt: null,
            lastExitReason: "cannot bind ingress port 43123: permission denied",
            serviceRegistered: false,
            runningTaskCount: 0,
            crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
            updatedAt: Date.now() + 1,
          }),
        0,
      );
      return {
        unref: vi.fn(),
        disconnect: vi.fn(),
        once: vi.fn(),
      };
    });
    const output: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "1");
    // Shift the clock past the ready-wait budget instead of waiting 25s in real time.
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    try {
      const pending = runServerCli(
        ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      );
      // Let the CLI fork the daemon and enter the ready wait before shifting the clock.
      await new Promise((resolve) => setTimeout(resolve, 250));
      skewMs = 30_000;
      const exit = await pending;

      expect(exit).toBe(1);
      const failure = JSON.parse(output.at(-1) ?? "{}");
      expect(failure.code).toBe("remote-connection-timeout");
      expect(failure.error).toBe(
        "Timed out waiting for Server ready (state=starting, last exit: cannot bind ingress port 43123: permission denied)",
      );
    } finally {
      nowSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for a reused starting Supervisor to report ready before returning", async () => {
    // Reusing a Supervisor that is still starting must not return exit 0 with port:null;
    // the caller needs the ready status with the real ingress port.
    const root = await mkdtemp(join(tmpdir(), "zdr-ready-"));
    const layout = resolveServerLayout(join(root, "server"));
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    const startingStatus = {
      ...readyStatus,
      state: "starting" as const,
      port: null,
      host: null,
      startedAt: null,
    };
    let statusRequests = 0;
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "status") throw new Error(`Unexpected command: ${request.command}`);
      statusRequests += 1;
      return statusRequests < 3 ? startingStatus : readyStatus;
    });
    const output: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "1");
    try {
      const exit = await runServerCli(
        ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      );

      expect(exit, output.join("")).toBe(0);
      expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ state: "ready", port: 43123 });
      // The CLI polled control until ready instead of returning the portless starting snapshot.
      expect(statusRequests).toBeGreaterThanOrEqual(3);
      expect(serviceMocks.fork).not.toHaveBeenCalled();
    } finally {
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
