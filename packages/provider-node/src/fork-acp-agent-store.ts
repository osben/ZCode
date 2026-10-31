import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  encodeForkAcpAgentCatalogFile,
  encodeForkAcpAgentModelVisibilityFile,
  encodeForkAcpAgentsFile,
  extractInlineAcpAgentRecords,
  normalizeAcpAgentHiddenModels,
  normalizeForkAcpAgentCatalogOptions,
  parseForkAcpAgentCatalogFile,
  parseForkAcpAgentModelVisibilityFile,
  forkAcpAgentsFileSchema,
  hasInlineAcpProviders,
  stripInlineAcpProviders,
  type ForkAcpAgentRecord,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
  type ForkAcpAgentSnapshot,
  type ForkAcpAgentCatalogEntry,
  type ForkAcpAgentCatalogOption,
  type ForkAcpAgentCatalogOptionInput,
  type ForkAcpAgentCatalogSnapshot,
  type ForkAcpAgentModelVisibilitySnapshot,
  type ForkAcpAgentStore,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

/** Fork-owned sidecar next to `provider_config.json` (AGENTS.md: fork-only state uses `fork_`). */
export const FORK_ACP_AGENTS_FILE_NAME = "fork_acp_agents.json";

export function resolveForkAcpAgentsFilePath(personalProviderConfigFilePath: string): string {
  return join(dirname(personalProviderConfigFilePath), FORK_ACP_AGENTS_FILE_NAME);
}

export interface NodeForkAcpAgentStoreOptions {
  readonly filePath: string;
  readonly onRecovery?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

/**
 * Single owner of the ACP agent records (specs/acp-agent-runtime.md "Storage and upstream
 * compatibility"). Same file discipline as the personal provider repository: atomic private
 * writes under a file lock, lock-free reads of the committed document, and polling so other
 * window hosts observe changes.
 */
export class NodeForkAcpAgentStore implements ForkAcpAgentStore {
  readonly #filePath: string;
  readonly #onRecovery?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #observedRevision: string | null = null;
  #recoveryReportedFor: string | null = null;
  #disposed = false;

  constructor(options: NodeForkAcpAgentStoreOptions) {
    if (!options.filePath.trim())
      throw new Error("Fork ACP agent store filePath must not be empty");
    this.#filePath = options.filePath;
    this.#onRecovery = options.onRecovery;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
  }

  async read(): Promise<ForkAcpAgentSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readFile();
      this.#observedRevision ??= snapshot.revision;
      this.#recoveryReportedFor = null;
      return snapshot;
    } catch (error) {
      // An invalid sidecar is preserved for the user to repair; read it as empty meanwhile.
      await this.#reportRecoveryOnce(error);
      return snapshotOf([]);
    }
  }

  /**
   * Reports an invalid sidecar once per file content. Every read (and every poll) of an unchanged
   * invalid file would otherwise log the same recovery again; a repaired and re-broken file reports again.
   */
  async #reportRecoveryOnce(error: unknown): Promise<void> {
    let revision: string;
    try {
      revision = createHash("sha256")
        .update(await readFile(this.#filePath))
        .digest("hex");
    } catch {
      // Unreadable at this moment: key by the error so one failure is still reported once.
      revision = `unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
    if (revision === this.#recoveryReportedFor) return;
    this.#recoveryReportedFor = revision;
    try {
      this.#onRecovery?.(error);
    } catch {
      // Observation callbacks must not block recovery.
    }
  }

  async update(
    transform: (current: readonly ForkAcpAgentRecord[]) => readonly ForkAcpAgentRecord[],
  ): Promise<ForkAcpAgentSnapshot> {
    this.#assertNotDisposed();
    const snapshot = await withFileLock(this.#filePath, async () => {
      // Reread under the lock; an invalid file throws here instead of being overwritten.
      const current = await this.#readFile();
      const encoded = encodeForkAcpAgentsFile(transform(current.agents));
      await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
      this.#writeGeneration += 1;
      const next = snapshotOf(encoded.agents);
      this.#observedRevision = next.revision;
      return next;
    });
    this.#emit("updated");
    return snapshot;
  }

  /**
   * Polling runs only while at least one listener is subscribed: an unobserved store (plain reads) schedules no timer.
   */
  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    this.#ensurePolling();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stopPolling();
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopPolling();
    this.#listeners.clear();
  }

  async #readFile(): Promise<ForkAcpAgentSnapshot> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) return snapshotOf([]);
      throw error;
    }
    return snapshotOf(forkAcpAgentsFileSchema.parse(JSON.parse(text) as unknown).agents);
  }

  #stopPolling(): void {
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
  }

  #ensurePolling(): void {
    if (
      this.#pollingIntervalMs === false ||
      this.#listeners.size === 0 ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readFile();
      // A poll that started before this process saved must not roll the revision back.
      if (writeGeneration !== this.#writeGeneration) return;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch {
      // Invalid or unreadable sidecar: keep the last published state; read() reports recovery.
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeForkAcpAgentStore is disposed");
  }
}

function snapshotOf(agents: readonly ForkAcpAgentRecord[]): ForkAcpAgentSnapshot {
  const encoded = encodeForkAcpAgentsFile(agents);
  return Object.freeze({
    revision: createHash("sha256").update(JSON.stringify(encoded)).digest("hex"),
    agents: encoded.agents,
  });
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export interface InlineAcpMigrationResult {
  /** Agent ids copied into the sidecar (existing sidecar records are kept and not counted). */
  readonly copied: readonly string[];
  /** Whether `provider_config.json` was rewritten without its migrated inline rules. */
  readonly stripped: boolean;
  /** Provider ids of `acp-agent` rules left in place because the sidecar holds no record for them. */
  readonly kept: readonly string[];
  /**
   * Agent ids whose inline rule differs from the sidecar record. The sidecar wins on read; the inline
   * rule stays in `provider_config.json` (it is not stripped) so no user data is dropped silently.
   */
  readonly conflicts: readonly string[];
}

/**
 * One-shot, idempotent move of legacy inline `acp-agent` providers out of the shared
 * `provider_config.json`. The sidecar is written first; a crash before the strip leaves both
 * copies, the sidecar wins on read, and the next run repeats the strip.
 */
export async function migrateInlineAcpProviders(
  personalRepository: PersonalProviderConfigRepository,
  store: ForkAcpAgentStore,
): Promise<InlineAcpMigrationResult> {
  const personal = await personalRepository.read();
  if (!hasInlineAcpProviders(personal))
    return { copied: [], stripped: false, kept: [], conflicts: [] };
  const inline = extractInlineAcpAgentRecords(personal);
  let copied: string[] = [];
  // Agent ids whose inline rule is now represented by an identical sidecar record (copied or equal).
  let strippable = new Set<string>();
  let conflicts: string[] = [];
  if (inline.length > 0) {
    await store.update((current) => {
      // The transform can be re-run by the store; every result is recomputed from `current`.
      const byId = new Map(current.map((agent) => [agent.agentId, agent] as const));
      const next = [...current];
      copied = [];
      strippable = new Set();
      conflicts = [];
      for (const agent of inline) {
        const existing = byId.get(agent.agentId);
        if (existing === undefined) {
          next.push(agent);
          copied.push(agent.agentId);
          strippable.add(agent.agentId);
        } else if (isDeepStrictEqual(existing, agent)) {
          strippable.add(agent.agentId);
        } else {
          conflicts.push(agent.agentId);
        }
      }
      return next;
    });
  }
  // The strip reruns under the personal file lock; only rules the sidecar now holds identically may
  // go, so a rule another writer added in between (or one that differs) survives.
  const sidecarAgentIds = strippable;
  const keptIn = (update: Pick<ProviderConfigLayerUpdate, "providers">) =>
    update.providers
      .rules()
      .filter((rule) => rule.config.access?.type === "acp-agent")
      .map((rule) => rule.providerId);
  if (stripInlineAcpProviders(personal, sidecarAgentIds) === personal) {
    // Nothing migratable: do not rewrite the shared file on every start.
    return { copied, stripped: false, kept: keptIn(personal), conflicts };
  }
  let stripped = false;
  let kept: string[] = [];
  await personalRepository.update((current) => {
    const next = stripInlineAcpProviders(current, sidecarAgentIds);
    stripped = next !== current;
    kept = keptIn(next);
    return next;
  });
  return { copied, stripped, kept, conflicts };
}

/** Fork-owned catalog next to `provider_config.json` (specs/acp-agent-runtime.md, "S6 readiness"). */
export const FORK_ACP_AGENT_CATALOG_FILE_NAME = "fork_acp_agent_catalog.json";

export function resolveForkAcpAgentCatalogFilePath(personalProviderConfigFilePath: string): string {
  return join(dirname(personalProviderConfigFilePath), FORK_ACP_AGENT_CATALOG_FILE_NAME);
}

export interface NodeForkAcpAgentCatalogStoreOptions {
  readonly filePath: string;
  /** Receives an invalid catalog file once per file content; the catalog then reads as empty. */
  readonly onRecovery?: (error: unknown) => void;
}

/**
 * Single owner of the per-agent option catalog. Writers run in the worker (turn reconcile) and in the host
 * (Settings Test) and share one file, so every write takes the file lock and rereads under it. Reads are
 * lock-free and tolerant. The catalog is a cache, so an invalid file is overwritten by the next write.
 */
export class NodeForkAcpAgentCatalogStore {
  readonly #filePath: string;
  readonly #onRecovery?: (error: unknown) => void;
  #recoveryReportedFor: string | null = null;

  constructor(options: NodeForkAcpAgentCatalogStoreOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Fork ACP agent catalog filePath must not be empty");
    }
    this.#filePath = options.filePath;
    this.#onRecovery = options.onRecovery;
  }

  async read(): Promise<ForkAcpAgentCatalogSnapshot> {
    try {
      return await this.#readFile();
    } catch (error) {
      await this.#reportRecoveryOnce(error);
      return Object.freeze({ agents: Object.freeze([]) });
    }
  }

  /** The last offered options of one agent, or undefined when the agent was never run or tested. */
  async readAgent(agentId: string): Promise<readonly ForkAcpAgentCatalogOption[] | undefined> {
    const entry = (await this.read()).agents.find((agent) => agent.agentId === agentId);
    return entry?.options;
  }

  /**
   * Stores the offered options of one agent. Returns false (and writes nothing) when the stored options are
   * already equal, so a turn that offers an unchanged snapshot causes no file write.
   */
  async write(
    agentId: string,
    offered: readonly ForkAcpAgentCatalogOptionInput[],
    capturedAt: number = Date.now(),
  ): Promise<boolean> {
    const options = normalizeForkAcpAgentCatalogOptions(offered);
    return withFileLock(this.#filePath, async () => {
      let current: readonly ForkAcpAgentCatalogEntry[];
      try {
        current = (await this.#readFile()).agents;
      } catch (error) {
        await this.#reportRecoveryOnce(error);
        current = [];
      }
      const existing = current.find((agent) => agent.agentId === agentId);
      if (existing !== undefined && isDeepStrictEqual(existing.options, options)) return false;
      const next: ForkAcpAgentCatalogEntry[] = [
        ...current.filter((agent) => agent.agentId !== agentId),
        { agentId, capturedAt, options: [...options] },
      ];
      const encoded = encodeForkAcpAgentCatalogFile(next);
      await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
      return true;
    });
  }

  async #readFile(): Promise<ForkAcpAgentCatalogSnapshot> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isCatalogFileNotFound(error)) return Object.freeze({ agents: Object.freeze([]) });
      throw error;
    }
    return parseForkAcpAgentCatalogFile(JSON.parse(text) as unknown);
  }

  async #reportRecoveryOnce(error: unknown): Promise<void> {
    let revision: string;
    try {
      revision = createHash("sha256")
        .update(await readFile(this.#filePath))
        .digest("hex");
    } catch {
      revision = `unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
    if (revision === this.#recoveryReportedFor) return;
    this.#recoveryReportedFor = revision;
    try {
      this.#onRecovery?.(error);
    } catch {
      // Observation callbacks must not block recovery.
    }
  }
}

function isCatalogFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Fork-owned model visibility next to `provider_config.json` (specs/acp-agent-runtime.md "Settings: models and Advanced"). */
export const FORK_ACP_AGENT_MODEL_VISIBILITY_FILE_NAME = "fork_acp_agent_model_visibility.json";

export function resolveForkAcpAgentModelVisibilityFilePath(
  personalProviderConfigFilePath: string,
): string {
  return join(dirname(personalProviderConfigFilePath), FORK_ACP_AGENT_MODEL_VISIBILITY_FILE_NAME);
}

export interface NodeForkAcpAgentModelVisibilityStoreOptions {
  readonly filePath: string;
  /** Receives an invalid visibility file once per file content; it then reads as empty. */
  readonly onRecovery?: (error: unknown) => void;
}

/**
 * Single owner of the model values hidden per agent. Only the host's settings service writes; every write takes
 * the file lock and rereads under it, and reads are lock-free and tolerant (an invalid file reads as empty and
 * the next write replaces it).
 */
export class NodeForkAcpAgentModelVisibilityStore {
  readonly #filePath: string;
  readonly #onRecovery?: (error: unknown) => void;
  #recoveryReportedFor: string | null = null;

  constructor(options: NodeForkAcpAgentModelVisibilityStoreOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Fork ACP agent model visibility filePath must not be empty");
    }
    this.#filePath = options.filePath;
    this.#onRecovery = options.onRecovery;
  }

  async read(): Promise<ForkAcpAgentModelVisibilitySnapshot> {
    try {
      return await this.#readFile();
    } catch (error) {
      await this.#reportRecoveryOnce(error);
      return Object.freeze({ agents: Object.freeze([]) });
    }
  }

  /** The hidden model values of one agent; empty when nothing is hidden. */
  async readAgent(agentId: string): Promise<readonly string[]> {
    const entry = (await this.read()).agents.find((agent) => agent.agentId === agentId);
    return entry?.hiddenModels ?? [];
  }

  /**
   * Replaces the hidden set of one agent; an empty set removes its entry. Returns false (and writes nothing)
   * when the stored set is already equal.
   */
  async write(agentId: string, hiddenModels: readonly string[]): Promise<boolean> {
    const next = normalizeAcpAgentHiddenModels(hiddenModels);
    return withFileLock(this.#filePath, async () => {
      let current: ForkAcpAgentModelVisibilitySnapshot["agents"];
      try {
        current = (await this.#readFile()).agents;
      } catch (error) {
        await this.#reportRecoveryOnce(error);
        current = [];
      }
      const existing = current.find((agent) => agent.agentId === agentId)?.hiddenModels ?? [];
      if (isDeepStrictEqual(existing, next)) return false;
      const agents = [
        ...current.filter((agent) => agent.agentId !== agentId),
        ...(next.length > 0 ? [{ agentId, hiddenModels: next }] : []),
      ];
      const encoded = encodeForkAcpAgentModelVisibilityFile(agents);
      await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
      return true;
    });
  }

  async #readFile(): Promise<ForkAcpAgentModelVisibilitySnapshot> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isCatalogFileNotFound(error)) return Object.freeze({ agents: Object.freeze([]) });
      throw error;
    }
    return parseForkAcpAgentModelVisibilityFile(JSON.parse(text) as unknown);
  }

  async #reportRecoveryOnce(error: unknown): Promise<void> {
    let revision: string;
    try {
      revision = createHash("sha256")
        .update(await readFile(this.#filePath))
        .digest("hex");
    } catch {
      revision = `unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
    if (revision === this.#recoveryReportedFor) return;
    this.#recoveryReportedFor = revision;
    try {
      this.#onRecovery?.(error);
    } catch {
      // Observation callbacks must not block recovery.
    }
  }
}
