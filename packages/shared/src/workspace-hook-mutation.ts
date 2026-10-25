import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { WorkspaceHookBundleSnapshotData } from "./workspace-hook-digest.js";
import { createWorkspaceHookDeclarationDigest } from "./workspace-hook-digest.js";
import {
  workspaceHooksConfigSchema,
  type WorkspaceHookDefinition,
} from "./workspace-hook-config.js";

export interface AtomicWorkspaceHookConfigWriteOptions {
  beforeRename?: () => void | Promise<void>;
}

export class WorkspaceHookMutationError extends Error {
  constructor(
    readonly code:
      | "workspace_hooks_snapshot_mismatch"
      | "workspace_hooks_bundle_changed"
      | "workspace_hooks_config_unreadable"
      | "workspace_hooks_config_write_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceHookMutationError";
  }
}

/**
 * Workspace Hook settings writes must never expose a partially-written config to Runtime watchers.
 * The temp file is written in the destination directory, flushed, closed, then atomically renamed.
 */
export async function atomicWriteWorkspaceHookConfig(
  filePath: string,
  value: Record<string, unknown>,
  options: AtomicWorkspaceHookConfigWriteOptions = {},
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.();
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeWorkspaceHookConfiguredToggle(input: {
  configPath: string;
  snapshot: WorkspaceHookBundleSnapshotData;
  reviewItemId: string;
  enabled: boolean;
  writeOptions?: AtomicWorkspaceHookConfigWriteOptions;
}): Promise<void> {
  const configPath = resolve(input.configPath);
  const entry = input.snapshot.hooks.find((item) => item.reviewItemId === input.reviewItemId);
  const source = entry ? input.snapshot.sourceFiles[entry.sourceFileIndex] : undefined;
  if (
    !entry ||
    !entry.editable ||
    !source?.editable ||
    source.configFileKind !== ".zcode/config.json" ||
    resolve(source.canonicalPath) !== configPath
  ) {
    throw mismatch("Workspace Hook toggle target is not the current editable project config");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    // This is a readFile/JSON.parse failure and must not be reported as config_write_failed:
    // the user would keep retrying the write when the actual issue is that the config cannot be read or is invalid JSON.
    throw new WorkspaceHookMutationError(
      "workspace_hooks_config_unreadable",
      "Workspace Hook config could not be read",
      { cause: error },
    );
  }
  if (!isRecord(raw)) throw mismatch("Workspace Hook config root is not an object");
  const parsedHooks = workspaceHooksConfigSchema.safeParse(raw.hooks);
  if (!parsedHooks.success) throw mismatch("Workspace Hook config no longer matches its schema");

  const rawHooks = raw.hooks;
  if (!isRecord(rawHooks)) throw mismatch("Workspace Hook config has no hooks object");
  const events = rawHooks.events;
  if (!isRecord(events)) throw mismatch("Workspace Hook config has no events object");
  const matchers = events[entry.event];
  if (!Array.isArray(matchers)) throw mismatch("Workspace Hook event no longer exists");
  const matcher = matchers[entry.matcherIndex];
  if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) {
    throw mismatch("Workspace Hook matcher no longer exists");
  }
  const rawDeclaration = matcher.hooks[entry.hookIndex];
  if (!isRecord(rawDeclaration)) throw mismatch("Workspace Hook declaration no longer exists");
  const parsedDeclaration = getParsedDeclaration(
    parsedHooks.data.events?.[entry.event]?.[entry.matcherIndex]?.hooks[entry.hookIndex],
  );
  if (!parsedDeclaration) throw mismatch("Workspace Hook declaration no longer matches its schema");

  // Deliberately replace the entry's own resolvedTimeoutMs / resolvedMaxOutputBytes with the digest's
  // "default" values here. This verifies that the declaration on disk still matches what was reviewed:
  // declaration fields such as source/command/event/matcher/hookIndex have not been changed since review.
  // Known limitation: if only root-level defaults (hooks.timeoutMs / hooks.maxOutputBytes) change on disk,
  // entry.resolvedTimeoutMs still contains the value resolved at review time. Recomputing after replacement
  // therefore yields the same entry.hookDeclarationDigest, and this guard will not detect the root default change
  // (even though resolvedTimeoutMs is included in the digest specifically so root changes can trigger re-review).
  // Admission is unaffected: hook execution is evaluated against the current snapshot and does not use this digest comparison,
  // so there is no privilege escalation risk.
  const currentDigest = createWorkspaceHookDeclarationDigest({
    sourceRelativePath: entry.sourceRelativePath,
    sourceDiscoveryOrder: source.discoveryOrder,
    event: entry.event,
    matcher: parsedHooks.data.events?.[entry.event]?.[entry.matcherIndex]?.matcher ?? null,
    matcherIndex: entry.matcherIndex,
    hookIndex: entry.hookIndex,
    hook: parsedDeclaration,
    defaultTimeoutMs: entry.resolvedTimeoutMs,
    resolvedMaxOutputBytes: entry.resolvedMaxOutputBytes,
  });
  if (currentDigest !== entry.hookDeclarationDigest) {
    throw mismatch("Workspace Hook declaration changed after review");
  }

  rawDeclaration.enabled = input.enabled;
  await atomicWriteWorkspaceHookConfig(configPath, raw, input.writeOptions);
}

function getParsedDeclaration(value: unknown): WorkspaceHookDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as WorkspaceHookDefinition;
}

function mismatch(message: string): WorkspaceHookMutationError {
  return new WorkspaceHookMutationError("workspace_hooks_snapshot_mismatch", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
