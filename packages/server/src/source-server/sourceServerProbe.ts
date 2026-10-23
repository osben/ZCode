import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  assertSupportedRemoteEnvironment,
  createUnsupportedRemotePlatformError,
  REMOTE_POSIX_SHELL_ONLY_MESSAGE,
} from "@zcode/server/remote/remotePlatformSupport.js";
import {
  collectCommand,
  readLastJsonLine,
  readUniqueVersion,
  throwIfAborted,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";
import type {
  SourceServerProbeOptions,
  SourceServerProbeResult,
  TransportContext,
} from "@zcode/server/source-server/transportAdapter.js";

const SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
const SERVER_BIN_SHELL = '"$HOME/.zcode/server/bin/zcode"';
const SERVER_CURRENT_SHELL = `${SERVER_ROOT_SHELL}/current.json`;
const SERVER_STATUS_SHELL = `${SERVER_ROOT_SHELL}/run/status.json`;
const SOURCE_SERVER_PROBE_MARKER_PREFIX = "__ZCODE_PROBE_";

function buildSourceServerProbeCommand(includeReleaseIdentity: boolean): string {
  return [
    "set +e",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}PLATFORM__\\n'`,
    "uname -s",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ARCH__\\n'`,
    "uname -m",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ROOT__\\n'`,
    `printf '%s\\n' ${SERVER_ROOT_SHELL}`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}KERNEL__\\n'`,
    "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}LIBC__\\n'`,
    // musl、macOS 或缺 getconf 时只留空段；set +e 下不影响 probe 退出码。
    "getconf GNU_LIBC_VERSION 2>/dev/null",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}INSTALLED__\\n'`,
    `if [ -f ${SERVER_BIN_SHELL} ]; then printf '1\\n'; else printf '0\\n'; fi`,
    ...(includeReleaseIdentity
      ? [
          `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}RELEASE__\\n'`,
          `if [ -r ${SERVER_CURRENT_SHELL} ]; then cat ${SERVER_CURRENT_SHELL}; fi`,
        ]
      : []),
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}VERSION__\\n'`,
    `if [ -r ${SERVER_CURRENT_SHELL} ]; then sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${SERVER_CURRENT_SHELL} | head -n 1; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}STATUS__\\n'`,
    // Bug 原因：每次 probe 启动两次完整 Server CLI，冷缓存时仅版本/状态读取就会耗尽
    // 10 秒启动预算。current/status 是 CLI 自身的权威持久化文件；status 仅在 PID 仍存活时复用。
    `if [ -r ${SERVER_STATUS_SHELL} ]; then status_pid=$(sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${SERVER_STATUS_SHELL} | head -n 1); if [ -n "$status_pid" ] && kill -0 "$status_pid" 2>/dev/null; then tr -d '\\r\\n' < ${SERVER_STATUS_SHELL}; printf '\\n'; fi; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}END__\\n'`,
  ].join("; ");
}

function readSourceServerProbeSections(output: string): Map<string, string> {
  const parts = output.split(/__ZCODE_PROBE_([A-Z]+)__\r?\n/gu);
  const sections = new Map<string, string>();
  for (let index = 1; index + 1 < parts.length; index += 2) {
    sections.set(parts[index]!, parts[index + 1]!.trim());
  }
  return sections;
}

/** 远端环境检查本身的失败；只有它归入预检失败，建立连接或执行命令的传输失败不借探测阶段兜底。 */
export class SourceServerProbeEnvironmentError extends Error {
  public override readonly name = "SourceServerProbeEnvironmentError";
}

// Minimum glibc of the Linux build of the Node runtime bundled in the Source Server archive. Kept in step with SERVER_RUNTIME_NODE_VERSION.
const SOURCE_SERVER_MIN_GLIBC_VERSION = [2, 28] as const;

// Windows shell signatures in stderr when the POSIX probe runs under PowerShell or cmd.exe.
const WINDOWS_NATIVE_SHELL_FAILURE_PATTERN =
  /CommandNotFoundException|FullyQualifiedErrorId|is not recognized as (?:an internal or external command|the name of a cmdlet)|The system cannot find the path specified/iu;

function isWindowsNativeShellFailure(stderr: string): boolean {
  return WINDOWS_NATIVE_SHELL_FAILURE_PATTERN.test(stderr);
}

// Warn-only since 3.16.3. Previously a rejection (ZCT-2112008575366098944): a glibc 2.17 host uploaded an
// ~87 MB archive before ld.so failed on the bundled runtime. The probe now logs the risk and lets install continue.
// An unreadable libc (musl, missing getconf, unrecognized output) cannot be judged and stays silent.
function warnUnsupportedGlibc(platform: string, libcText: string, context: TransportContext): void {
  if (platform !== "linux") return;
  const match = /^glibc\s+(\d+)\.(\d+)/iu.exec(libcText);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = SOURCE_SERVER_MIN_GLIBC_VERSION;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
  const required = SOURCE_SERVER_MIN_GLIBC_VERSION.join(".");
  context.onLog?.({
    phase: "probe",
    level: "warn",
    message:
      `Remote glibc ${major}.${minor} is older than glibc ${required} required by the bundled ZCode Source Server runtime. ` +
      "ZCode Source Server may fail to start. Continuing installation or connection.",
  });
}

export async function probeSourceServer(
  backend: IRemoteBackend,
  context: TransportContext,
  options: SourceServerProbeOptions,
): Promise<SourceServerProbeResult> {
  throwIfAborted(context.signal);
  // Bug 原因：冷启动曾串行/并发创建多个 SSH channel 读取环境、安装、release、version、status；
  // 串行会超出 10 秒预算，并发又会在首次握手期触发 Bad packet length。一个只读 POSIX channel
  // 同时给三种 Backend 使用，既保留 Adapter 合同，也把 probe 收敛为单次远端 round-trip。
  const result = await collectCommand(
    await backend.exec(buildSourceServerProbeCommand(options.includeReleaseIdentity === true)),
  );
  if (result.exitCode !== 0) {
    // A failed probe may be a daemon-level failure (for example Docker stopped). Let the backend re-check and throw its
    // own diagnosis first, so the user sees the root cause instead of a generic exit status.
    await backend.diagnoseExecFailure?.();
    if (isWindowsNativeShellFailure(result.stderr)) {
      throw Object.assign(createUnsupportedRemotePlatformError(REMOTE_POSIX_SHELL_ONLY_MESSAGE), {
        cause: new Error(result.stderr.trim()),
      });
    }
    throw new SourceServerProbeEnvironmentError(
      result.stderr.trim() || "Source Server environment probe failed",
    );
  }
  const sections = readSourceServerProbeSections(result.stdout);
  const reportedPlatform = sections.get("PLATFORM") ?? "";
  const kernelOstype = sections.get("KERNEL") ?? "";
  const environment = {
    platform: resolveRemotePlatform(normalizeRemotePlatform(reportedPlatform), kernelOstype),
    arch: normalizeRemoteArch(sections.get("ARCH") ?? ""),
    ...(sections.get("ROOT") ? { installPath: sections.get("ROOT") } : {}),
  };
  // The platform error keeps its public code; it is not wrapped as a probe-environment failure.
  assertSupportedRemoteEnvironment(environment);
  warnUnsupportedGlibc(environment.platform, sections.get("LIBC") ?? "", context);
  const installed = sections.get("INSTALLED") === "1";
  if (!installed) return { ...environment, installed: false };

  let installedArchiveSha256: string | undefined;
  const releaseText = sections.get("RELEASE");
  if (releaseText) {
    try {
      const current = JSON.parse(releaseText) as { archiveSha256?: unknown };
      if (
        typeof current.archiveSha256 === "string" &&
        /^[a-f0-9]{64}$/iu.test(current.archiveSha256)
      ) {
        installedArchiveSha256 = current.archiveSha256.toLowerCase();
      }
    } catch (error) {
      // Bug 原因：同 version 的旧开发安装可能没有 archive 身份；缺失必须投影为未知，
      // 由开发态内容寻址策略触发刷新，不能让旧 Server 的元数据格式阻断 probe。
      context.onLog?.({
        phase: "probe",
        message: `Source Server release identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const versionText = sections.get("VERSION") ?? "";
  const statusText = sections.get("STATUS") ?? "";
  let installedVersion: string | undefined;
  let daemonStatus: SourceServerProbeResult["daemonStatus"];
  try {
    if (versionText) installedVersion = readUniqueVersion(versionText);
  } catch {
    installedVersion = undefined;
  }
  try {
    if (statusText) daemonStatus = readLastJsonLine(statusText) as typeof daemonStatus;
  } catch {
    daemonStatus = undefined;
  }
  return {
    ...environment,
    installed: true,
    ...(installedArchiveSha256 ? { installedArchiveSha256 } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
