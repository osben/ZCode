import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  encodeForkAcpAgentsFile,
  extractInlineAcpAgentRecords,
  forkAcpAgentsFileSchema,
  hasInlineAcpProviders,
  stripInlineAcpProviders,
  type ForkAcpAgentRecord,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
  type ForkAcpAgentSnapshot,
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
      return snapshot;
    } catch (error) {
      // An invalid sidecar is preserved for the user to repair; read it as empty meanwhile.
      try {
        this.#onRecovery?.(error);
      } catch {
        // Observation callbacks must not block recovery.
      }
      return snapshotOf([]);
    } finally {
      this.#ensurePolling();
    }
  }

  async update(
    transform: (current: readonly ForkAcpAgentRecord[]) => readonly ForkAcpAgentRecord[],
  ): Promise<ForkAcpAgentSnapshot> {
    this.#assertNotDisposed();
    try {
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
    } finally {
      this.#ensurePolling();
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
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

  #ensurePolling(): void {
    if (
      this.#pollingIntervalMs === false ||
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
  if (!hasInlineAcpProviders(personal)) return { copied: [], stripped: false, kept: [] };
  const inline = extractInlineAcpAgentRecords(personal);
  let copied: string[] = [];
  const sidecar =
    inline.length > 0
      ? await store.update((current) => {
          const known = new Set(current.map((agent) => agent.agentId));
          const added = inline.filter((agent) => !known.has(agent.agentId));
          copied = added.map((agent) => agent.agentId);
          return [...current, ...added];
        })
      : await store.read();
  // The strip reruns under the personal file lock; only rules the sidecar now holds may go, so
  // a rule another writer added in between (or one that could not become a record) survives.
  const sidecarAgentIds = new Set(sidecar.agents.map((agent) => agent.agentId));
  const keptIn = (update: Pick<ProviderConfigLayerUpdate, "providers">) =>
    update.providers
      .rules()
      .filter((rule) => rule.config.access?.type === "acp-agent")
      .map((rule) => rule.providerId);
  if (stripInlineAcpProviders(personal, sidecarAgentIds) === personal) {
    // Nothing migratable: do not rewrite the shared file on every start.
    return { copied, stripped: false, kept: keptIn(personal) };
  }
  let stripped = false;
  let kept: string[] = [];
  await personalRepository.update((current) => {
    const next = stripInlineAcpProviders(current, sidecarAgentIds);
    stripped = next !== current;
    kept = keptIn(next);
    return next;
  });
  return { copied, stripped, kept };
}
