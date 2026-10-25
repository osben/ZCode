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
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { buildChildEnv } from "./launch.js";

export interface AcpAgentDefinition {
  readonly agentId: string;
  readonly displayName: string;
  /** Binary names probed on PATH, in order. */
  readonly binaries: readonly string[];
  /** Fixed version-probe arguments; never derived from user input. */
  readonly versionArgs: readonly string[];
  /** Default CLI arguments that start the agent in ACP server mode. */
  readonly spawnArgs: readonly string[];
  /** CLI arguments that start the interactive login flow from the settings UI; empty when there is none. */
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
  {
    agentId: "qwen",
    displayName: "Qwen Code",
    binaries: ["qwen"],
    versionArgs: ["--version"],
    // Native ACP server (qwen-code 0.19.x). `qwen auth` is removed upstream, so no login helper.
    spawnArgs: ["--acp"],
    loginArgs: [],
  },
  {
    agentId: "codex",
    displayName: "Codex",
    // Adapter over the user's Codex login; Codex itself has no native ACP server.
    binaries: ["codex-acp"],
    versionArgs: ["--version"],
    spawnArgs: [],
    loginArgs: [],
  },
  {
    agentId: "claude",
    displayName: "Claude Code",
    // Adapter over the user's Claude Code login (no adapter login flag).
    binaries: ["claude-agent-acp"],
    versionArgs: ["--version"],
    spawnArgs: [],
    loginArgs: [],
  },
  {
    agentId: "gemini",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    versionArgs: ["--version"],
    // Documented as experimental in the Gemini CLI reference. Not live-verified here: gemini is not installed.
    spawnArgs: ["--experimental-acp"],
    loginArgs: [],
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

/**
 * Runs one version probe. `env` is the scrubbed child environment built by
 * the shared `buildChildEnv` from the detection env.
 */
export type AcpVersionProbeRunner = (
  commandPath: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
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

/**
 * ACP agents are supported on macOS only until Windows and Linux are verified (specs/acp-agent-runtime.md,
 * "S6 readiness"). This is the single predicate: detection, the worker and host gates and the settings bridge
 * all ask it, so no platform answers "supported" through a second check.
 */
export function acpAgentPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export const DEFAULT_ACP_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_ACP_DETECTION_CACHE_TTL_MS = 60_000;

const MAX_VERSION_LENGTH = 200;
/** Only flags that ask a CLI to print its version are allowed in probes. */
const SAFE_VERSION_PROBE_ARG = /^(-v|-V|--version|-version|version|--ver)$/;

interface DetectionCacheEntry {
  readonly cachedAt: number;
  readonly entries: readonly AcpAgentDetection[];
}

/** Bounded cache: unrelated detection inputs must never share cached entries. */
const DETECTION_CACHE_MAX_KEYS = 16;
let detectionCache = new Map<string, DetectionCacheEntry>();
/** Bumped by `refreshAcpAgentCache`: a run started before a refresh never writes the cache. */
let detectionEpoch = 0;
/** One in-flight detection per cache key; concurrent callers share it. */
let inflightDetections = new Map<string, Promise<readonly AcpAgentDetection[]>>();
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
 * Detects all known agents with asynchronous IO; results are cached per
 * effective input set for `cacheTtlMs`, and concurrent calls with the same
 * inputs share one in-flight run.
 */
export function detectAcpAgents(
  options: DetectAcpAgentsOptions = {},
): Promise<readonly AcpAgentDetection[]> {
  const ttl = options.cacheTtlMs ?? DEFAULT_ACP_DETECTION_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cacheKey = detectionCacheKey(options);
  if (ttl > 0) {
    const cached = detectionCache.get(cacheKey);
    if (cached && now() - cached.cachedAt < ttl) return Promise.resolve(cached.entries);
  }
  const inflight = inflightDetections.get(cacheKey);
  if (inflight) return inflight;
  const epoch = detectionEpoch;
  const inflightMap = inflightDetections;
  const run = (async () => {
    const entries = await Promise.all(
      ACP_AGENT_DEFINITIONS.map((definition) => detectAgent(definition, options)),
    );
    const frozen = Object.freeze(entries);
    if (ttl > 0 && epoch === detectionEpoch) {
      if (detectionCache.size >= DETECTION_CACHE_MAX_KEYS && !detectionCache.has(cacheKey)) {
        const oldest = detectionCache.keys().next().value;
        if (oldest !== undefined) detectionCache.delete(oldest);
      }
      detectionCache.set(cacheKey, Object.freeze({ cachedAt: now(), entries: frozen }));
    }
    return frozen;
  })().finally(() => {
    if (inflightMap.get(cacheKey) === run) inflightMap.delete(cacheKey);
  });
  inflightMap.set(cacheKey, run);
  return run;
}

/** Drops cached and in-flight results; a run already in flight finishes but is not cached. */
export function refreshAcpAgentCache(): void {
  detectionEpoch += 1;
  detectionCache = new Map();
  inflightDetections = new Map();
}

async function detectAgent(
  definition: AcpAgentDefinition,
  options: DetectAcpAgentsOptions,
): Promise<AcpAgentDetection> {
  const commandPath = await resolveCommandOnPath(definition.binaries, options);
  return {
    agentId: definition.agentId,
    displayName: definition.displayName,
    installed: commandPath !== null,
    commandPath,
    version: commandPath === null ? null : await probeVersion(definition, commandPath, options),
  };
}

const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".com", ".exe"];
/**
 * Node launches detected agents with `shell: false`, and Windows
 * command-script shims (`.bat`/`.cmd`, the only form an npm global install
 * provides) cannot be executed that way — `spawn` rejects them with EINVAL
 * (CVE-2024-27980 hardening). Only extensions CreateProcess can run directly
 * are probed, so a script-only install is reported as not installed instead
 * of being detected with an unusable `commandPath`. Exported for tests;
 * other platforms probe the bare binary name only.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".com", ".exe"]);

export function buildBinaryCandidateNames(
  binary: string,
  pathext: string | undefined,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32") return [binary];
  const extensions = (pathext ?? "")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const effective = extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATH_EXTENSIONS;
  return effective
    .filter((extension) => WINDOWS_EXECUTABLE_EXTENSIONS.has(extension))
    .map((extension) => `${binary}${extension}`);
}

async function resolveCommandOnPath(
  binaries: readonly string[],
  options: DetectAcpAgentsOptions,
): Promise<string | null> {
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
        if (await isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
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
      // The probe is a child like any other: same scrubbed environment.
      buildChildEnv(options.env ?? process.env),
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
  env: Readonly<Record<string, string>>,
): Promise<AcpVersionProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(
      commandPath,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        // A non-zero exit still carries the output: some CLIs print their
        // version to stderr and exit 1.
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          status: error ? (typeof code === "number" ? code : null) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
    // Version probes never read input; close stdin so a CLI cannot block on it.
    child.stdin?.end();
  });
}
