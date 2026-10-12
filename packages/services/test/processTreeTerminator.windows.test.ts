import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "@zcode/services/process/processTreeTerminator";

const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

let targetedPowerShellResult: string | undefined;
let targetedPowerShellResultsByPid: Map<number, string>;
let powershellResult: string;
let powershellError: Error | null;
let powershellDelayMs: number;
let targetedPowerShellUsesConfiguredTimeout: boolean;
let onPowerShellQuery: (() => void) | undefined;
let alivePids: Set<number>;
let taskkillRemovesOnGraceful: boolean;

function powershellIdentity(pid: number, parentPid: number): string {
  return powershellIdentityAt(pid, parentPid, Date.UTC(2026, 6, 24, 11, 0, 0));
}

function powershellIdentityAt(pid: number, parentPid: number, utcMilliseconds: number): string {
  const ticks = DOTNET_UNIX_EPOCH_TICKS + BigInt(utcMilliseconds) * 10_000n;
  return `${pid} ${parentPid} ${ticks}\n`;
}

describe("terminateProcessTree Windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 24, 12, 0, 0)));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    alivePids = new Set([4242]);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (alivePids.has(Number(pid))) return true;
      throw Object.assign(new Error("process not found"), { code: "ESRCH" });
    });
    targetedPowerShellResult = undefined;
    targetedPowerShellResultsByPid = new Map();
    powershellResult = powershellIdentity(4242, 1);
    powershellError = null;
    powershellDelayMs = 0;
    targetedPowerShellUsesConfiguredTimeout = false;
    onPowerShellQuery = undefined;
    taskkillRemovesOnGraceful = false;
    execFileMock
      .mockReset()
      .mockImplementation(
        (
          command: string,
          args: string[],
          options: { timeout?: number },
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (command === "powershell.exe") {
            onPowerShellQuery?.();
            const targeted = args.some((arg) => arg.includes("ProcessId ="));
            const targetedPid = Number(
              /ProcessId = (\d+)/u.exec(args.find((arg) => arg.includes("ProcessId =")) ?? "")?.[1],
            );
            const resultAtInvocation = targeted
              ? (targetedPowerShellResultsByPid.get(targetedPid) ??
                targetedPowerShellResult ??
                powershellIdentity(targetedPid, targetedPid === 5000 ? 4242 : 1))
              : powershellResult;
            const reply = () => callback(powershellError, resultAtInvocation, "");
            const delayMs =
              targeted && targetedPowerShellUsesConfiguredTimeout
                ? (options.timeout ?? 0)
                : powershellDelayMs;
            if (delayMs > 0) setTimeout(reply, delayMs);
            else reply();
          } else {
            const pid = Number(args[1]);
            if (taskkillRemovesOnGraceful || args.includes("/F")) {
              alivePids.delete(pid);
            }
            callback(null, "", "");
          }
          return {};
        },
      );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Windows 进程快照直接使用 PowerShell/CIM", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);

    expect(snapshot?.rootPid).toBe(4242);
    expect(execFileMock.mock.calls.filter(([command]) => command === "wmic.exe")).toHaveLength(0);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(1);
  });

  it("非等待式回收到 force deadline 后不使用旧快照强杀 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    // Reason for the fix: the Node exit callback may arrive after the OS-level exit and PID reuse; without a fresh
    // CreationDate recheck at the deadline, /F must not be sent to the bare root PID based on the stale snapshot.
    terminateProcessTree(child, { forceAfterMs: 20 });
    await vi.advanceTimersByTimeAsync(20);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 前定向复核 CreationDate 匹配才强杀 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 前直接使用 PowerShell 定向复核 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核为 PowerShell 保留完整预算", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellUsesConfiguredTimeout = true;
    powershellResult = powershellIdentity(4242, 1);

    terminateProcessTree(child, { forceAfterMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 4242")]),
      expect.objectContaining({ timeout: 750, windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("force 定向复核失败时仅对受管 live root 使用句柄兜底", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellError = Object.assign(new Error("simulated targeted CIM timeout"), {
      code: "ETIMEDOUT",
    });
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) => {
      if (force && pid === 4242) {
        alivePids.delete(pid);
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }
      return Promise.resolve({});
    });

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          { parentPid: 1, pid: 4242, startTime: "windows-utc-us:1784890800000000" },
          { parentPid: 4242, pid: 5000, startTime: "windows-utc-us:1784890800000000" },
        ],
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    // Safety contract: the live root handle of a managed ChildProcess is root-only ownership evidence; when the CIM
    // targeted recheck fails, the root may still be closed out, but unverified descendants must not be added to the
    // explicit /F targets.
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(880);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000] });
  });

  it("graceful 挂起时 force 会强杀本次仍匹配的 root 与已验证后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    // Bug regression: the old deadlineSnapshotOnly branch kept only the root, so verified descendants never got an
    // /F flight.
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
  });

  it("force 前后代 PID 已复用时跳过该 PID 但继续收口匹配的 root", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult = `${powershellIdentity(4242, 1)}${powershellIdentity(5000, 4242)}`;
    targetedPowerShellResultsByPid.set(5000, powershellIdentity(6000, 1));
    const windowsTaskkillRunner = vi.fn(({ force, pid }: { force: boolean; pid: number }) =>
      force
        ? Promise.resolve().then(() => {
            alivePids.delete(pid);
            if (pid === 4242) {
              child.exitCode = 1;
              child.emit("exit", 1, null);
            }
            return {};
          })
        : new Promise<Record<string, never>>(() => {}),
    );

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 1_000,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: true,
      pid: 4242,
      timeoutMs: 100,
    });
    expect(windowsTaskkillRunner).not.toHaveBeenCalledWith({
      force: true,
      pid: 5000,
      timeoutMs: 100,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Command", expect.stringContaining("ProcessId = 5000")]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    // A mismatch can be PID reuse or a degraded query. The safety boundary is to not force-kill, and to keep
    // reporting the old identity as unconfirmed residue; a failed recheck must never be misjudged as cleanup success.
    await vi.advanceTimersByTimeAsync(880);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000] });
  });

  it("force timer 先于 exit 回调且 PID 已复用时不强杀新 root", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    targetedPowerShellResult = powershellIdentity(6000, 1);

    terminateProcessTree(child, { forceAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(250);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("PowerShell 全量快照与身份过滤保持同一进程创建身份", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(snapshot!.identities, {})).toEqual(
      snapshot!.identities,
    );

    const secondSnapshot = await captureProcessTreeSnapshotAsync(child);
    expect(await filterCurrentProcessIdentitiesAsync(secondSnapshot!.identities, {})).toEqual(
      secondSnapshot!.identities,
    );
  });

  it("PowerShell 查询耗尽预算后 force 复用快照且不重复查询", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    powershellResult = powershellIdentity(4242, 1);

    const snapshot = await captureProcessTreeSnapshotAsync(child);
    const fullQueryCount = execFileMock.mock.calls.filter(
      ([command, args]) =>
        command === "powershell.exe" &&
        !(args as string[]).some((arg) => arg.includes("ProcessId =")),
    ).length;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(
      execFileMock.mock.calls.filter(
        ([command, args]) =>
          command === "powershell.exe" &&
          !(args as string[]).some((arg) => arg.includes("ProcessId =")),
      ),
    ).toHaveLength(fullQueryCount);
    await vi.advanceTimersByTimeAsync(31);
    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("进程表快照查询本身也受 transport 全链路绝对 deadline 约束", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 50;
    let settled = false;

    const snapshotPromise = captureProcessTreeSnapshotAsync(child, {
      windowsCleanupDeadlineAtMs: Date.now() + 40,
    });
    void snapshotPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    // The old implementation kept waiting for PowerShell until 60ms; once the absolute deadline is reached it must
    // degrade to unavailable immediately, letting the transport proceed into its bounded fail-closed close-out.
    expect(settled).toBe(true);
    await expect(snapshotPromise).resolves.toBeUndefined();
    // Let the underlying mock query truncated by the absolute-deadline race finish, so the module-level shared flight
    // does not pollute later cases.
    await vi.advanceTimersByTimeAsync(20);
  });

  it("不为晚于共享查询启动的新 root 复用过期进程表", async () => {
    const firstChild = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    const secondChild = {
      exitCode: null,
      pid: 6000,
      signalCode: null,
    } as ChildProcess;
    powershellDelayMs = 20;

    const firstSnapshotPromise = captureProcessTreeSnapshotAsync(firstChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(1);
    powershellResult = powershellIdentity(6000, 1);
    const secondSnapshotPromise = captureProcessTreeSnapshotAsync(secondChild, {
      ownedProcessStartedAtMs: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(firstSnapshotPromise).resolves.toMatchObject({ rootPid: 4242 });
    await expect(secondSnapshotPromise).resolves.toMatchObject({ rootPid: 6000 });
  });

  it("等待 graceful taskkill flight 与稍后投递的 exit 后再判定完成", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let completeTaskkill: (() => void) | undefined;
    const windowsTaskkillRunner = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          completeTaskkill = () => {
            alivePids.delete(4242);
            resolve({});
          };
        }),
    );
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: await captureProcessTreeSnapshotAsync(child),
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // Bug regression: the old waiter reported remaining PIDs on a fixed force-wait window while the graceful taskkill
    // had not settled; a real process may deliver the ChildProcess exit only a few milliseconds later.
    await vi.advanceTimersByTimeAsync(31);
    expect(result).toBeUndefined();

    completeTaskkill?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    setTimeout(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }, 5);
    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 4242,
      timeoutMs: 100,
    });
  });

  it("root 查询期间退出并复用 PID 时不认领新进程后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    powershellResult =
      powershellIdentityAt(4242, 1, Date.UTC(2026, 6, 24, 11, 30, 0)) +
      powershellIdentityAt(5000, 4242, Date.UTC(2026, 6, 24, 11, 30, 0, 100));
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
    });
    expect(snapshot).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("root 查询期间退出且有可信 exit 时间时恢复并回收旧后代", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([5000]);
    taskkillRemovesOnGraceful = true;
    powershellResult = powershellIdentity(5000, 4242);
    const exitedAtMs = Date.UTC(2026, 6, 24, 11, 30, 0);
    onPowerShellQuery = () => {
      child.exitCode = 0;
    };

    const snapshot = await captureProcessTreeSnapshotAsync(child, {
      ownedProcessStartedAtMs: Date.UTC(2026, 6, 24, 10, 0, 0),
      resolveOwnedProcessExitedAtMs: () => exitedAtMs,
    });
    expect(snapshot?.identities.map((identity) => identity.pid)).toEqual([5000]);

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot,
      waitAfterForceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "5000", "/T"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("双后端查询失败时等待未验证 root 并明确报告残留", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;

    powershellResult = "";
    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillTimeoutMs: 20,
    });
    let result: Awaited<typeof resultPromise> | undefined;
    void resultPromise.then((value) => {
      result = value;
    });

    // When the query fails and there are no verified identities, both graceful/force targets are empty; there is no
    // actual taskkill to wait for, so the deadline must not unconditionally reserve the taskkill timeout.
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ remainingPids: [4242] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("没有 taskkill 目标时使用 transport 剩余预算观察延迟正常退出", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });
    setTimeout(() => {
      alivePids.delete(4242);
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 600);

    // Bug regression: with no identity safe to taskkill, the old waiter compressed the 1s absolute budget down to
    // waitAfterForceMs=30ms, misreporting the subsequent normal code=0 exit as residue.
    await vi.advanceTimersByTimeAsync(30);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(570);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [] });
    expect(execFileMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("纯观察窗口不突破 Local Host 四秒总上界", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsCleanupDeadlineAtMs: Date.now() + 1_000,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // Worst case, the first cleanup takes 3.25s; the final retry can only observe for 750ms more, and it must report
    // the real residue before the Local Host's 4s forced-exit point — the full 1.25s retry budget must not be
    // serially stacked on top.
    await vi.advanceTimersByTimeAsync(749);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [4242] });
  });

  it("未验证 root 仍有已验证目标时保留 taskkill deadline", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    alivePids = new Set([4242, 5000]);
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 20,
      snapshot: {
        rootPid: 4242,
        descendantPids: [5000],
        identities: [
          {
            parentPid: 4242,
            pid: 5000,
            startTime: "20260724190000.000000+480",
          },
        ],
        identityVerification: "unavailable",
      },
      waitAfterForceMs: 30,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 20,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    // Even when the root cannot be verified, as long as a verified descendant exists the graceful taskkill is a real
    // flight; keep the full budget and do not report early at the force + grace 50ms boundary.
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);

    await expect(resultPromise).resolves.toEqual({ remainingPids: [5000, 4242] });
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 5000,
      timeoutMs: 20,
    });
  });

  it("全链路绝对 deadline 会扣除进入 waiter 前已消耗的快照与 EOF 时间", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: 4242,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    const windowsTaskkillRunner = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    let result: Awaited<ReturnType<typeof terminateProcessTreeAndWait>> | undefined;

    const resultPromise = terminateProcessTreeAndWait(child, {
      forceAfterMs: 0,
      snapshot: {
        rootPid: 4242,
        descendantPids: [],
        identities: [
          {
            parentPid: 1,
            pid: 4242,
            startTime: "20260724190000.000000+480",
          },
        ],
      },
      waitAfterForceMs: 30,
      // Simulate snapshot + EOF having already consumed 3,210ms: only 40ms of the transport's 3,250ms end-to-end
      // budget remains.
      windowsCleanupDeadlineAtMs: Date.now() + 40,
      windowsTaskkillRunner,
      windowsTaskkillTimeoutMs: 100,
    });
    void resultPromise.then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    // The old implementation would still be undefined here and wrongly extend the window to 130ms; the assertion must
    // fail fast instead of waiting on the old deadline and timing out the fake-timer case itself.
    expect(result).toEqual({ remainingPids: [4242] });
    await expect(resultPromise).resolves.toEqual(result);
    expect(windowsTaskkillRunner).toHaveBeenCalledWith({
      force: false,
      pid: 4242,
      timeoutMs: 100,
    });
  });

  it("CIM 硬不可用时缓存 capability 并跳过后续身份查询", async () => {
    const child = {
      exitCode: null,
      pid: 4242,
      signalCode: null,
    } as ChildProcess;
    powershellError = Object.assign(new Error("powershell unavailable"), { code: "ENOENT" });

    await expect(captureProcessTreeSnapshotAsync(child)).resolves.toBeUndefined();
    const queryCount = execFileMock.mock.calls.filter(
      ([command]) => command === "powershell.exe",
    ).length;

    await expect(
      filterCurrentProcessIdentitiesAsync(
        [{ parentPid: 1, pid: 4242, startTime: "windows-utc-us:1784890800000000" }],
        {},
      ),
    ).resolves.toEqual([]);
    expect(
      execFileMock.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toHaveLength(queryCount);
  });
});
