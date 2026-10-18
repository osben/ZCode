import { execFile } from "node:child_process";
import type { ProcessIdentity, ProcessTreeTerminatorOptions } from "./processTreeTypes.js";

const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MICROSECOND = 10n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

type WindowsCimCapability = "cim" | "identity-unavailable";

interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}

let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;

function isHardCimUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function remainingWindowsCleanupMs(options: ProcessTreeTerminatorOptions): number | undefined {
  return options.windowsCleanupDeadlineAtMs === undefined
    ? undefined
    : Math.max(options.windowsCleanupDeadlineAtMs - Date.now(), 0);
}

function boundedWindowsLookupTimeoutMs(
  defaultTimeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): number {
  const remainingMs = remainingWindowsCleanupMs(options);
  return remainingMs === undefined
    ? defaultTimeoutMs
    : Math.max(Math.min(defaultTimeoutMs, remainingMs), 0);
}

async function awaitWindowsProcessListWithinDeadline(
  request: Promise<readonly ProcessIdentity[]>,
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  const remainingMs = remainingWindowsCleanupMs(options);
  if (remainingMs === undefined) return await request;
  if (remainingMs <= 0) return [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<readonly ProcessIdentity[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), remainingMs);
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, rawStartTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const startTime = normalizePowerShellStartTime(rawStartTime);
    if (pid === undefined || parentPid === undefined || !startTime) continue;
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function normalizePowerShellStartTime(rawStartTime: string | undefined): string | undefined {
  if (!rawStartTime) return undefined;
  try {
    const unixMicroseconds =
      (BigInt(rawStartTime) - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MICROSECOND;
    return `${WINDOWS_START_TIME_PREFIX}${unixMicroseconds}`;
  } catch {
    return undefined;
  }
}

export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  if (windowsCimCapability === "identity-unavailable") return false;
  // Windows 11 24H2 and some Windows 10 images no longer include WMIC; use
  // PowerShell/CIM on all Windows 10+ systems. If the query fails, treat CreationDate as unverified and do not force-kill without identity validation.
  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            `Windows root 身份 PowerShell 复核失败 pid=${identity.pid}:`,
            error ?? stderr,
          );
          resolve(false);
          return;
        }
        const current = parseWindowsProcessList(stdout).find(
          (processIdentity) => processIdentity.pid === identity.pid,
        );
        windowsCimCapability = "cim";
        resolve(current?.startTime === identity.startTime);
      },
    );
  });
}

export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const ownedProcessStartedAtMs = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (ownedProcessStartedAtMs === undefined ||
      ownedProcessStartedAtMs < windowsProcessListInFlight.startedAtMs)
  ) {
    return await awaitWindowsProcessListWithinDeadline(windowsProcessListInFlight.promise, options);
  }

  // Get-CimInstance can take more than one second on some Windows machines. Synchronous waiting would block the Host
  // exit deadline; sharing one asynchronous query lets multiple workspaces reuse a single system process list.
  // An older shared Promise may have started before a new Agent was spawned, so reusing that process list would miss
  // the new root and fall back to unverified. A query is reusable only if it started strictly after the root.
  const startedAtMs = Date.now();
  const request = new Promise<readonly ProcessIdentity[]>((resolve) => {
    // With WMIC removed, use the supported CIM backend directly so an ENOENT fallback does not consume the cleanup
    // deadline. Return an empty identity on query failure so the caller continues observing exit through the fail-closed path.
    const timeoutMs = boundedWindowsLookupTimeoutMs(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, options);
    if (timeoutMs <= 0) {
      resolve([]);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(options, "查询 Windows runtime 进程表失败（异步）:", error ?? stderr);
          resolve([]);
          return;
        }
        const identities = parseWindowsProcessList(stdout);
        if (identities.length === 0)
          warn(options, "PowerShell 未返回可解析的 Windows runtime 进程表");
        if (identities.length > 0) windowsCimCapability = "cim";
        resolve(identities);
      },
    );
  }).finally(() => {
    if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
  });
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await awaitWindowsProcessListWithinDeadline(request, options);
}
