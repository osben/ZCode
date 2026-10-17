/**
 * Detection registry for external ACP agent CLIs.
 *
 * Long-lived GUI processes usually lack the user's login-shell PATH, so this
 * module never reads `process.env` implicitly: the host captures the
 * login-shell environment and passes it (plus extra path entries) through
 * options. Probes are injectable and asynchronous (the host event loop must
 * not block on a hung CLI), and version probes only ever use the fixed,
 * whitelisted argument sets declared in `ACP_AGENT_DEFINITIONS`.
 */
import { spawn, type ChildProcess } from "node:child_process";
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
) => AcpVersionProbeResult | Promise<AcpVersionProbeResult>;

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
/** Cap per probe stream so a chatty CLI cannot exhaust host memory. */
const MAX_PROBE_OUTPUT_CHARS = 1024 * 1024;
/** Only flags that ask a CLI to print its version are allowed in probes. */
const SAFE_VERSION_PROBE_ARG = /^(-v|-V|--version|-version|version|--ver)$/;

interface DetectionCacheEntry {
  readonly cachedAt: number;
  readonly entries: readonly AcpAgentDetection[];
}

/** Bounded cache: unrelated detection inputs must never share cached entries. */
const DETECTION_CACHE_MAX_KEYS = 16;
let detectionCache = new Map<string, DetectionCacheEntry>();
let nextProbeIdentity = 1;
const probeIdentities = new WeakMap<AcpVersionProbeRunner, number>();

/**
 * Cache key over every caller-supplied input that changes detection results:
 * the searched PATH, extra path entries, the probe timeout, and the probe
 * runner's identity (different runners must not reuse each other's versions).
 * The injected clock only drives TTL bookkeeping and is not part of the key.
 */
function detectionCacheKey(options: DetectAcpAgentsOptions): string {
  const env = options.env ?? process.env;
  let probeId = 0;
  if (options.runProbe) {
    probeId = probeIdentities.get(options.runProbe) ?? 0;
    if (probeId === 0) {
      probeId = nextProbeIdentity++;
      probeIdentities.set(options.runProbe, probeId);
    }
  }
  return JSON.stringify([
    env.PATH ?? "",
    env.PATHEXT ?? "",
    options.extraPathEntries ?? [],
    options.probeTimeoutMs ?? null,
    probeId,
  ]);
}

export function isSafeVersionProbeArgs(args: readonly string[]): boolean {
  return args.length > 0 && args.every((arg) => SAFE_VERSION_PROBE_ARG.test(arg));
}

/**
 * Detects all known agents; results are cached per effective input set for
 * `cacheTtlMs`. Asynchronous by design: probes must not block the host event
 * loop when an installed CLI hangs on `--version`.
 */
export async function detectAcpAgents(
  options: DetectAcpAgentsOptions = {},
): Promise<readonly AcpAgentDetection[]> {
  const ttl = options.cacheTtlMs ?? DEFAULT_ACP_DETECTION_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cacheKey = detectionCacheKey(options);
  if (ttl > 0) {
    const cached = detectionCache.get(cacheKey);
    if (cached && now() - cached.cachedAt < ttl) return cached.entries;
  }
  const entries = await Promise.all(
    ACP_AGENT_DEFINITIONS.map((definition) => detectAgent(definition, options)),
  );
  const frozen: readonly AcpAgentDetection[] = Object.freeze(entries);
  if (ttl > 0) {
    if (detectionCache.size >= DETECTION_CACHE_MAX_KEYS && !detectionCache.has(cacheKey)) {
      const oldest = detectionCache.keys().next().value;
      if (oldest !== undefined) detectionCache.delete(oldest);
    }
    detectionCache.set(cacheKey, Object.freeze({ cachedAt: now(), entries: frozen }));
  }
  return frozen;
}

export function refreshAcpAgentCache(): void {
  detectionCache = new Map();
}

async function detectAgent(
  definition: AcpAgentDefinition,
  options: DetectAcpAgentsOptions,
): Promise<AcpAgentDetection> {
  const commandPath = resolveCommandOnPath(definition.binaries, options);
  return {
    agentId: definition.agentId,
    displayName: definition.displayName,
    installed: commandPath !== null,
    commandPath,
    version: commandPath === null ? null : await probeVersion(definition, commandPath, options),
  };
}

const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Windows resolves executables through PATHEXT, so `opencode`/`cursor-agent`
 * must also be probed as `opencode.exe`, `opencode.cmd`, … . Exported for
 * tests; other platforms probe the bare binary name only.
 */
export function buildBinaryCandidateNames(
  binary: string,
  pathext: string | undefined,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32") return [binary];
  const extensions = (pathext ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const effective = extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATH_EXTENSIONS;
  return [binary, ...effective.map((extension) => `${binary}${extension.toLowerCase()}`)];
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
      for (const name of buildBinaryCandidateNames(binary, env.PATHEXT)) {
        const candidate = join(entry, name);
        if (isExecutableFile(candidate)) return candidate;
      }
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

async function probeVersion(
  definition: AcpAgentDefinition,
  commandPath: string,
  options: DetectAcpAgentsOptions,
): Promise<string | null> {
  if (!isSafeVersionProbeArgs(definition.versionArgs)) return null;
  const runProbe = options.runProbe ?? defaultRunProbe;
  try {
    const result = await runProbe(
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
): Promise<AcpVersionProbeResult> {
  return new Promise<AcpVersionProbeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    let child: ChildProcess;
    try {
      child = spawn(commandPath, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ status: null, stdout: "", stderr: "" });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_PROBE_OUTPUT_CHARS) stderr += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}
