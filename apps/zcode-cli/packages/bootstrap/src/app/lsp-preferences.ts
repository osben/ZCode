// Single owner of the LSP user preferences sidecar: <cliStorageRoot>/fork_lsp_preferences.json.
// Spec: apps/zcode-cli/docs/design/v2/tool/19-lsp.md §3. The file is fork-only state and must never
// be stored in setting.json, which is re-parsed by each build's settings schema and would drop keys.
import { join } from "node:path";
import {
  DEFAULT_LSP_PREFERENCES,
  FileSystemPortError,
  LSP_PREFERENCES_FILE_NAME,
  LspPreferencesSchema,
  type FileSystemPort,
  type LspPreferences,
  type Logger,
} from "@zcode/contracts";

export interface LspPreferencesPatch {
  enabled?: boolean;
  /** `null` removes the per-server override and falls back to the plugin manifest default. */
  diagnosticsAfterEdit?: Record<string, boolean | null>;
}

export type LspPreferencesListener = (preferences: LspPreferences) => void;

export interface LspPreferencesStore {
  /** Reads the sidecar. Missing, unreadable, or invalid content yields defaults and never throws. */
  load(): Promise<LspPreferences>;
  /** Latest in-memory state; defaults until `load` or `update` has run. */
  get(): LspPreferences;
  /** Merges the patch and persists it atomically. Updates are applied one at a time, in call order. */
  update(patch: LspPreferencesPatch): Promise<LspPreferences>;
  subscribe(listener: LspPreferencesListener): () => void;
}

export interface CreateLspPreferencesStoreOptions {
  fileSystem: FileSystemPort;
  cliStorageRoot: string;
  logger?: Logger;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

export function createLspPreferencesStore(
  options: CreateLspPreferencesStoreOptions,
): LspPreferencesStore {
  const { fileSystem, cliStorageRoot } = options;
  const logger = options.logger ?? noopLogger;
  const filePath = join(cliStorageRoot, LSP_PREFERENCES_FILE_NAME);
  const listeners = new Set<LspPreferencesListener>();
  let current: LspPreferences = cloneDefaults();
  // Every read-modify-write runs inside this chain so that a patch always merges onto the state
  // written by the previous one; load shares the chain so it cannot overwrite a newer update.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  function setCurrent(next: LspPreferences): void {
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        logger.warn("LSP preference listener failed", { error: String(error) });
      }
    }
  }

  async function readFromDisk(): Promise<LspPreferences> {
    let content: string;
    try {
      content = (await fileSystem.readTextFile({ path: filePath })).content;
    } catch (error) {
      if (error instanceof FileSystemPortError && error.code === "not_found") {
        return cloneDefaults();
      }
      logger.warn("LSP preferences file unreadable; using defaults", {
        error: String(error),
      });
      return cloneDefaults();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.warn("LSP preferences file is not valid JSON; using defaults");
      return cloneDefaults();
    }
    const result = LspPreferencesSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn("LSP preferences file failed schema validation; using defaults");
      return cloneDefaults();
    }
    return result.data;
  }

  async function writeToDisk(next: LspPreferences): Promise<void> {
    await fileSystem.writeTextFile({
      path: filePath,
      content: `${JSON.stringify(next, null, 2)}\n`,
      atomic: true,
      createParents: true,
    });
  }

  return {
    load() {
      return enqueue(async () => {
        const loaded = await readFromDisk();
        setCurrent(loaded);
        return loaded;
      });
    },

    get() {
      return current;
    },

    update(patch) {
      return enqueue(async () => {
        const next = applyPatch(current, patch);
        // Persist first: listeners and `get()` only ever observe what is on disk.
        await writeToDisk(next);
        setCurrent(next);
        return next;
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function cloneDefaults(): LspPreferences {
  return { ...DEFAULT_LSP_PREFERENCES, diagnosticsAfterEdit: {} };
}

function applyPatch(base: LspPreferences, patch: LspPreferencesPatch): LspPreferences {
  const diagnosticsAfterEdit = { ...base.diagnosticsAfterEdit };
  for (const [serverId, value] of Object.entries(patch.diagnosticsAfterEdit ?? {})) {
    if (value === null) {
      delete diagnosticsAfterEdit[serverId];
    } else {
      diagnosticsAfterEdit[serverId] = value;
    }
  }
  return {
    version: 1,
    enabled: patch.enabled ?? base.enabled,
    diagnosticsAfterEdit,
  };
}
