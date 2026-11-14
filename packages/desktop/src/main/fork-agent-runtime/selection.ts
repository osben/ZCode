import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import {
  FORK_AGENT_RUNTIME_ENV,
  FORK_RUST_AGENT_PATH_ENV,
  forkAgentRuntimeSchema,
  type ForkAgentRuntime,
} from "@zcode/shared";

/**
 * Fork agent runtime selection, Main side (specs/fork-agent-runtime-selection.md).
 *
 * Main decides once per app process, before the first Host fork, and every Host it spawns gets the
 * same frozen decision through its env. A settings change therefore applies after a restart and
 * windows never mix runtimes.
 */

export type ForkAgentRuntimeSelectionSource = "env" | "setting" | "default";

export interface ForkAgentRuntimeSelection {
  selected: ForkAgentRuntime;
  effective: ForkAgentRuntime;
  source: ForkAgentRuntimeSelectionSource;
  rustAgentPath?: string;
  /** Why effective differs from selected; absent when they match. */
  fallbackReason?: "binary_missing";
  /** A shell value that was not node|rust and was ignored. */
  ignoredEnvValue?: string;
}

interface SelectionLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const RUST_AGENT_RESOURCE_DIR = "zcode-rs";

export function rustAgentBinaryName(platform: NodeJS.Platform | string = process.platform): string {
  return platform === "win32" ? "zcode-rs.exe" : "zcode-rs";
}

/** Candidate locations, first match wins. Never under resources/glm (the native fallback scans it). */
export function resolveRustAgentBinaryCandidates(options: {
  explicitPath?: string;
  isPackaged: boolean;
  resourcesPath?: string;
  devResourcesDir: string;
  platform?: NodeJS.Platform | string;
}): string[] {
  const name = rustAgentBinaryName(options.platform);
  if (options.explicitPath) return [options.explicitPath];
  if (options.isPackaged) {
    return options.resourcesPath
      ? [join(options.resourcesPath, RUST_AGENT_RESOURCE_DIR, name)]
      : [];
  }
  return [join(options.devResourcesDir, RUST_AGENT_RESOURCE_DIR, name)];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pure precedence: shell env > stored setting > build default; then binary availability. */
export async function resolveForkAgentRuntimeSelection(options: {
  envValue: string | undefined;
  storedSetting: unknown;
  /** The build's default runtime: "rust" for ZCode Preview RS, "node" otherwise. */
  buildDefault?: ForkAgentRuntime;
  binaryCandidates: string[];
  isUsable?: (path: string) => Promise<boolean>;
}): Promise<ForkAgentRuntimeSelection> {
  const envRaw = options.envValue?.trim();
  const envParsed = envRaw ? forkAgentRuntimeSchema.safeParse(envRaw) : undefined;
  const settingParsed = forkAgentRuntimeSchema.safeParse(options.storedSetting);
  const ignoredEnvValue = envRaw && !envParsed?.success ? envRaw : undefined;
  const [selected, source]: [ForkAgentRuntime, ForkAgentRuntimeSelectionSource] = envParsed?.success
    ? [envParsed.data, "env"]
    : settingParsed.success
      ? [settingParsed.data, "setting"]
      : [options.buildDefault ?? "node", "default"];
  const base = { selected, source, ...(ignoredEnvValue ? { ignoredEnvValue } : {}) };
  if (selected === "node") return { ...base, effective: "node" };
  const isUsable = options.isUsable ?? isExecutable;
  for (const candidate of options.binaryCandidates) {
    if (await isUsable(candidate)) return { ...base, effective: "rust", rustAgentPath: candidate };
  }
  return { ...base, effective: "node", fallbackReason: "binary_missing" };
}

/** Host env entries: Main deletes inherited values and writes only the decided ones. */
export function buildForkAgentRuntimeHostEnv(
  inheritedEnv: Record<string, string>,
  selection: ForkAgentRuntimeSelection | undefined,
): Record<string, string> {
  const env = { ...inheritedEnv };
  delete env[FORK_AGENT_RUNTIME_ENV];
  delete env[FORK_RUST_AGENT_PATH_ENV];
  const effective = selection?.effective ?? "node";
  env[FORK_AGENT_RUNTIME_ENV] = effective;
  if (effective === "rust" && selection?.rustAgentPath) {
    env[FORK_RUST_AGENT_PATH_ENV] = selection.rustAgentPath;
  }
  return env;
}

let latched: Promise<ForkAgentRuntimeSelection> | undefined;
let latchedValue: ForkAgentRuntimeSelection | undefined;

/** Resolve once per process; later calls return the same decision (restart to change it). */
export function primeForkAgentRuntimeSelection(options: {
  readStoredSetting: () => Promise<unknown>;
  buildDefault?: ForkAgentRuntime;
  logger: SelectionLogger;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  devResourcesDir?: string;
}): Promise<ForkAgentRuntimeSelection> {
  latched ??= (async () => {
    const env = options.env ?? process.env;
    let storedSetting: unknown;
    try {
      storedSetting = await options.readStoredSetting();
    } catch (error) {
      // The error message can carry the settings path; log only its code.
      options.logger.warn(
        "[agent-runtime] reading the agentRuntime setting failed, using default",
        {
          code: (error as { code?: unknown } | null)?.code ?? "unknown",
        },
      );
    }
    const selection = await resolveForkAgentRuntimeSelection({
      envValue: env[FORK_AGENT_RUNTIME_ENV],
      storedSetting,
      buildDefault: options.buildDefault,
      binaryCandidates: resolveRustAgentBinaryCandidates({
        explicitPath: env[FORK_RUST_AGENT_PATH_ENV]?.trim() || undefined,
        isPackaged: options.isPackaged,
        resourcesPath: process.resourcesPath,
        devResourcesDir:
          options.devResourcesDir ?? join(import.meta.dirname, "..", "..", "resources"),
      }),
    });
    const meta = {
      selected: selection.selected,
      effective: selection.effective,
      source: selection.source,
    };
    if (selection.ignoredEnvValue) {
      options.logger.warn(`[agent-runtime] ignored invalid ${FORK_AGENT_RUNTIME_ENV} value`);
    }
    if (selection.fallbackReason) {
      options.logger.warn("[agent-runtime] rust agent binary missing, running node", {
        ...meta,
        reason: selection.fallbackReason,
      });
    } else {
      options.logger.info("[agent-runtime] selection resolved", meta);
    }
    latchedValue = selection;
    return selection;
  })();
  return latched;
}

/** Synchronous read for Host spawn; undefined before priming (Host then gets node). */
export function getForkAgentRuntimeSelection(): ForkAgentRuntimeSelection | undefined {
  return latchedValue;
}

/** Test-only reset of the process latch. */
export function resetForkAgentRuntimeSelectionForTests(): void {
  latched = undefined;
  latchedValue = undefined;
}
