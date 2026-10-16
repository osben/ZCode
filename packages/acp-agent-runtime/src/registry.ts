/**
 * Detection registry for external ACP agent CLIs.
 *
 * Long-lived GUI processes usually lack the user's login-shell PATH, so this
 * module never reads `process.env` implicitly: the host captures the
 * login-shell environment and passes it (plus extra path entries) through
 * options. Probes are injectable for deterministic tests, and version probes
 * only ever use the fixed, whitelisted argument sets declared in
 * `ACP_AGENT_DEFINITIONS`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface AcpAgentDefinition {
  readonly agentId: string;
  readonly displayName: string;
  /** Binary names probed on PATH, in order. */
  readonly binaries: readonly string[];
  /** Fixed version-probe arguments; never derived from user input. */
  readonly versionArgs: readonly string[];
  /** Default CLI arguments that start the agent in ACP server mode. */
  readonly spawnArgs: readonly string[];
  /** CLI arguments that start the interactive login flow from the settings UI. */
  readonly loginArgs: readonly string[];
  /** Fixed, non-interactive arguments that print auth status; omit when unsupported. */
  readonly statusArgs?: readonly string[];
}

export const ACP_AGENT_DEFINITIONS: readonly AcpAgentDefinition[] = Object.freeze([
  {
    agentId: "opencode",
    displayName: "opencode",
    binaries: ["opencode"],
    versionArgs: ["--version"],
    spawnArgs: ["acp"],
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "list"],
  },
  {
    agentId: "cursor",
    displayName: "Cursor",
    // The Cursor CLI binary is `cursor-agent`. Never probe bare `agent`:
    // unrelated CLIs (e.g. grok) install under that name.
    binaries: ["cursor-agent"],
    versionArgs: ["--version"],
    spawnArgs: ["acp"],
    loginArgs: ["login"],
    statusArgs: ["status"],
  },
]);

export interface AcpAgentDetection {
  readonly agentId: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly commandPath: string | null;
  readonly version: string | null;
}

export interface AcpVersionProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type AcpVersionProbeRunner = (
  commandPath: string,
  args: readonly string[],
  timeoutMs: number,
) => AcpVersionProbeResult;

export interface DetectAcpAgentsOptions {
  /** Environment whose PATH is searched; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Extra PATH entries searched before the environment entries. */
  readonly extraPathEntries?: readonly string[];
  readonly probeTimeoutMs?: number;
  /** Result cache TTL; 0 disables caching. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly runProbe?: AcpVersionProbeRunner;
}

export const DEFAULT_ACP_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_ACP_DETECTION_CACHE_TTL_MS = 60_000;

const MAX_VERSION_LENGTH = 200;
/** Only flags that ask a CLI to print its version are allowed in probes. */
const SAFE_VERSION_PROBE_ARG = /^(-v|-V|--version|-version|version|--ver)$/;

let detectionCache: {
  readonly cachedAt: number;
  readonly entries: readonly AcpAgentDetection[];
} | null = null;

export function isSafeVersionProbeArgs(args: readonly string[]): boolean {
  return args.length > 0 && args.every((arg) => SAFE_VERSION_PROBE_ARG.test(arg));
}

/** Detects all known agents; results are cached for `cacheTtlMs`. */
export function detectAcpAgents(
  options: DetectAcpAgentsOptions = {},
): readonly AcpAgentDetection[] {
  const ttl = options.cacheTtlMs ?? DEFAULT_ACP_DETECTION_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  if (ttl > 0 && detectionCache && now() - detectionCache.cachedAt < ttl) {
    return detectionCache.entries;
  }
  const entries: AcpAgentDetection[] = ACP_AGENT_DEFINITIONS.map((definition) =>
    detectAgent(definition, options),
  );
  const frozen = Object.freeze(entries);
  if (ttl > 0) detectionCache = Object.freeze({ cachedAt: now(), entries: frozen });
  return frozen;
}

export function refreshAcpAgentCache(): void {
  detectionCache = null;
}

function detectAgent(
  definition: AcpAgentDefinition,
  options: DetectAcpAgentsOptions,
): AcpAgentDetection {
  const commandPath = resolveCommandOnPath(definition.binaries, options);
  return {
    agentId: definition.agentId,
    displayName: definition.displayName,
    installed: commandPath !== null,
    commandPath,
    version: commandPath === null ? null : probeVersion(definition, commandPath, options),
  };
}

function resolveCommandOnPath(
  binaries: readonly string[],
  options: DetectAcpAgentsOptions,
): string | null {
  const env = options.env ?? process.env;
  const entries = [
    ...(options.extraPathEntries ?? []),
    ...(env.PATH ?? "").split(delimiter),
  ].filter((entry) => entry.length > 0);
  const unique = [...new Set(entries)];
  for (const binary of binaries) {
    if (binary.includes("/") || binary.includes("\\")) continue;
    for (const entry of unique) {
      const candidate = join(entry, binary);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeVersion(
  definition: AcpAgentDefinition,
  commandPath: string,
  options: DetectAcpAgentsOptions,
): string | null {
  if (!isSafeVersionProbeArgs(definition.versionArgs)) return null;
  const runProbe = options.runProbe ?? defaultRunProbe;
  try {
    const result = runProbe(
      commandPath,
      definition.versionArgs,
      options.probeTimeoutMs ?? DEFAULT_ACP_PROBE_TIMEOUT_MS,
    );
    return firstNonEmptyLine(`${result.stdout}\n${result.stderr}`);
  } catch {
    return null;
  }
}

function firstNonEmptyLine(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, MAX_VERSION_LENGTH);
  }
  return null;
}

function defaultRunProbe(
  commandPath: string,
  args: readonly string[],
  timeoutMs: number,
): AcpVersionProbeResult {
  const result = spawnSync(commandPath, [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
