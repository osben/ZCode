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
const SERVER_DOWNGRADE_SHELL = `${SERVER_ROOT_SHELL}/downgrade.json`;
const SOURCE_SERVER_PROBE_MARKER_PREFIX = "__ZCODE_PROBE_";

function buildSourceServerProbeCommand(includeReleaseIdentity: boolean): string {
  return [
    "set +e",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}PLATFORM__\\n'`,
    // Cause: `set +e` plus a trailing printf turned a uname failure into exit 0, so empty fields were then reported as an unsupported system.
    // System and architecture are required results; only failures of these two commands end the probe, and optional metadata may still be missing.
    "uname -s || exit $?",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ARCH__\\n'`,
    "uname -m || exit $?",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ROOT__\\n'`,
    `printf '%s\\n' ${SERVER_ROOT_SHELL}`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}KERNEL__\\n'`,
    "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}LIBC__\\n'`,
    // The bundled Node needs glibc 2.28. musl has no GNU_LIBC_VERSION, so only its dynamic linker can be checked; check glibc first,
    // because glibc systems such as Debian also get /lib/ld-musl-*.so.1 when the musl package is installed. macOS prints neither.
    "if libc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null); then printf '%s\\n' \"$libc_version\"; else for musl_loader in /lib/ld-musl-*.so.1; do if [ -e \"$musl_loader\" ]; then printf 'musl\\n'; break; fi; done; fi",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}INSTALLED__\\n'`,
    `if [ -f ${SERVER_BIN_SHELL} ]; then printf '1\\n'; else printf '0\\n'; fi`,
    ...(includeReleaseIdentity
      ? [
          `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}RELEASE__\\n'`,
          `if [ -r ${SERVER_CURRENT_SHELL} ]; then cat ${SERVER_CURRENT_SHELL}; fi`,
        ]
      : []),
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}RELEASEID__\\n'`,
    `if [ -r ${SERVER_CURRENT_SHELL} ]; then sed -n 's/^[[:space:]]*"releaseId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${SERVER_CURRENT_SHELL} | head -n 1; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}DOWNGRADE__\\n'`,
    `if [ -r ${SERVER_DOWNGRADE_SHELL} ]; then tr -d '\\r\\n' < ${SERVER_DOWNGRADE_SHELL}; printf '\\n'; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}VERSION__\\n'`,
    `if [ -r ${SERVER_CURRENT_SHELL} ]; then sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${SERVER_CURRENT_SHELL} | head -n 1; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}STATUS__\\n'`,
    // Cause: every probe start ran two full Server CLI invocations, so with a cold cache reading only version/status could exhaust
    // the 10-second start budget. current/status are the CLI's own authoritative persisted files; status is reused only while its PID is still alive.
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

/** Failure of the remote environment check itself; only this is classified as a probe failure. Transport failures while connecting or running commands are not rescued by the probe stage. */
export class SourceServerProbeEnvironmentError extends Error {
  public override readonly name = "SourceServerProbeEnvironmentError";
}

// English signatures in stderr when the POSIX probe runs under cmd.exe or PowerShell, where `/bin/sh` is not found. A uname
// failure also exits non-zero, so only an explicit Windows shell error marks the target unsupported; not every probe failure
// belongs to this class.
// Bug cause: the old logic also treated U+FFFD (non-UTF-8 bytes) as a GBK Windows error. Garbled output only shows lossy
// decoding: a POSIX login shell's startup script can print a locale encoding error and exit before the probe runs, and
// wsl.exe's Chinese messages are UTF-16LE. Both were reported as an unsupported Windows native remote host. Only garbled
// output keeps the environment-check failure and the raw stderr.
const WINDOWS_NATIVE_SHELL_FAILURE_PATTERN =
  /CommandNotFoundException|FullyQualifiedErrorId|is not recognized as (?:an internal or external command|the name of a cmdlet)|The system cannot find the path specified/iu;

// Minimum glibc of the Linux build of the Node runtime bundled in the Source Server archive. Kept in step with SERVER_RUNTIME_NODE_VERSION.
const SOURCE_SERVER_MIN_GLIBC_VERSION = [2, 28] as const;

function isWindowsNativeShellFailure(stderr: string): boolean {
  return WINDOWS_NATIVE_SHELL_FAILURE_PATTERN.test(stderr);
}

// Warn-only since 3.16.3. Previously a rejection (ZCT-2112008575366098944): a glibc 2.17 host uploaded an
// ~87 MB archive before ld.so failed on the bundled runtime. The probe now logs the risk and lets install continue.
// An unreadable libc (missing getconf, unrecognized output) cannot be judged and stays silent; musl is warned
// because the bundled Node cannot run on it.
function warnUnsupportedLibc(platform: string, libcText: string, context: TransportContext): void {
  if (platform !== "linux") return;
  // The old implementation treated the system glibc report as grounds to reject the connection, so even an existing service
  // could not be tried. Keep the compatibility risk hint for the bundled runtime; whether it runs is decided by the later install/start. Unknown versions are not guessed.
  let detected: string;
  const match = /^glibc\s+(\d+)\.(\d+)/iu.exec(libcText);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const [minMajor, minMinor] = SOURCE_SERVER_MIN_GLIBC_VERSION;
    if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
    detected = `Remote glibc ${major}.${minor} is older than`;
  } else if (libcText === "musl") {
    // The bundled Node was measured not to run on musl (it still reports fcntl64: symbol not found after gcompat), so it is only hinted too.
    detected = "Remote uses musl libc instead of";
  } else {
    return;
  }
  const required = SOURCE_SERVER_MIN_GLIBC_VERSION.join(".");
  context.onLog?.({
    phase: "probe",
    level: "warn",
    message:
      `${detected} glibc ${required} required by the bundled ZCode Source Server runtime. ZCode Source Server may fail to start. ` +
      "Continuing installation or connection.",
  });
}

/** The downgrade marker belongs only to the release that wrote it; it is void once current points at another release. */
function readDowngradedFrom(markerText: string, currentReleaseId: string): string | undefined {
  if (!markerText || !currentReleaseId) return undefined;
  try {
    const marker = JSON.parse(markerText) as { releaseId?: unknown; fromVersion?: unknown };
    return marker.releaseId === currentReleaseId &&
      typeof marker.fromVersion === "string" &&
      marker.fromVersion.trim()
      ? marker.fromVersion.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export async function probeSourceServer(
  backend: IRemoteBackend,
  context: TransportContext,
  options: SourceServerProbeOptions,
): Promise<SourceServerProbeResult> {
  throwIfAborted(context.signal);
  // Cause: a cold start used to create several SSH channels in series or in parallel to read environment, install, release, version and status;
  // series exceeded the 10-second budget, and parallel channels triggered Bad packet length during the first handshake. One read-only POSIX channel
  // serves all three Backend kinds, keeping the Adapter contract and reducing the probe to a single remote round-trip.
  const result = await collectCommand(
    await backend.exec(buildSourceServerProbeCommand(options.includeReleaseIdentity === true)),
  );
  if (result.exitCode !== 0) {
    // A failed probe may be a daemon-level failure (for example Docker stopped; docker exec then also exits 1, which
    // looks like a remote script failure). Let the backend confirm the transport first and throw its own diagnosis, so the
    // user sees the root cause instead of a generic exit status.
    await backend.diagnoseExecFailure?.();
    // Windows OpenSSH defaults to cmd/PowerShell, where the fixed /bin/sh cannot start. Report the unsupported platform
    // instead of showing the garbled stderr as the cause.
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
  // Cause (ZCT-2114700808714715136): exit 0 does not guarantee the script ran to completion; missing fields defaulted to empty,
  // which not only misreported an unsupported system but also treated a missing INSTALLED as not installed and overwrote the install state of an existing Source.
  // Reject incomplete results at the single probe boundary, so callers never pick packages or change install state based on unknown values.
  const invalidFields = ["PLATFORM", "ARCH", "ROOT"].filter((field) => !sections.get(field));
  if (!["0", "1"].includes(sections.get("INSTALLED") ?? "")) invalidFields.push("INSTALLED");
  if (!sections.has("END")) invalidFields.push("END");
  if (invalidFields.length) {
    const stderr = result.stderr.trim().slice(0, 2_048);
    throw new SourceServerProbeEnvironmentError(
      `Source Server environment probe returned incomplete or invalid output: ${invalidFields.join(", ")}` +
        (stderr ? `; ${stderr}` : ""),
    );
  }
  const reportedPlatform = sections.get("PLATFORM") ?? "";
  const kernelOstype = sections.get("KERNEL") ?? "";
  const environment = {
    platform: resolveRemotePlatform(normalizeRemotePlatform(reportedPlatform), kernelOstype),
    arch: normalizeRemoteArch(sections.get("ARCH") ?? ""),
    ...(sections.get("ROOT") ? { installPath: sections.get("ROOT") } : {}),
  };
  // The platform error keeps its public code; it is not wrapped as a probe-environment failure.
  assertSupportedRemoteEnvironment(environment);
  warnUnsupportedLibc(environment.platform, sections.get("LIBC") ?? "", context);
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
      // Cause: an old development install of the same version may lack archive identity; the missing value must be projected as unknown,
      // so the development content-addressing policy triggers a refresh, and the old Server's metadata format must not block the probe.
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
  const downgradedFrom = readDowngradedFrom(
    sections.get("DOWNGRADE") ?? "",
    sections.get("RELEASEID") ?? "",
  );
  return {
    ...environment,
    installed: true,
    ...(installedArchiveSha256 ? { installedArchiveSha256 } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(downgradedFrom ? { downgradedFrom } : {}),
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
