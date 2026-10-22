/**
 * Fork-owned ACP session binding per ZCode session (specs/acp-agent-runtime.md "S5" and "S6"). The row
 * names the ACP session an external agent can resume (`session/load`) after a cold start or a restart,
 * and keeps the agent's offered config options (display copy) and the user's chosen values. It lives in
 * `fork_acp_session_binding` (migrations 9003 and 9004), so upstream session repositories never read it.
 *
 * Each call opens the session database for itself, so no connection outlives the call. The config of a
 * session is read on every subscribe of an ACP session, so the store keeps the last read per session. Every
 * write of this store drops the session's entry; the worker is the only writer of these rows.
 */
import { DatabaseSync } from "node:sqlite";
import type { ExternalAgentConfigOption } from "@zcode/contracts";

/** Lock wait for a busy session database; longer than any single write the session store makes. */
const SESSION_DB_BUSY_TIMEOUT_MS = 5_000;

export interface ForkAcpSessionBinding {
  readonly agentId: string;
  readonly acpSessionId: string;
  readonly cwd: string;
  /** Digest of the launch config the ACP session was created under; never the config itself. */
  readonly launchKey: string;
}

/** Config state of a binding. Choices belong to the binding's agent process configuration. */
export interface ForkAcpSessionConfig {
  /** Agent of the binding row; undefined when the session has no binding. */
  readonly agentId: string | undefined;
  /** Last offered options (display copy); undefined before the first turn. */
  readonly offered: readonly ExternalAgentConfigOption[] | undefined;
  /** Chosen values by config id. */
  readonly choices: Readonly<Record<string, string>>;
}

export interface ForkAcpSessionBindingStore {
  read(sessionId: string): Promise<ForkAcpSessionBinding | undefined>;
  /** Upserts the binding columns only; offered options and choices are kept. */
  write(sessionId: string, binding: ForkAcpSessionBinding): Promise<void>;
  /** Deletes the row, so the offered options and the choices go with the binding. */
  clear(sessionId: string): Promise<void>;
  readConfig(sessionId: string): Promise<ForkAcpSessionConfig>;
  /** Replaces the offered options of an existing binding; no-op without a row. */
  writeOffered(sessionId: string, options: readonly ExternalAgentConfigOption[]): Promise<void>;
  /** Sets one chosen value of an existing binding; no-op without a row. */
  writeChoice(sessionId: string, configId: string, value: string): Promise<void>;
}

interface BindingRow {
  agent_id: string;
  acp_session_id: string;
  cwd: string;
  launch_key: string;
}

interface ConfigRow {
  agent_id: string;
  config_options: string | null;
  config_choices: string | null;
}

/** Bounded so a long-lived worker does not keep every session it has ever seen. */
const CONFIG_CACHE_LIMIT = 256;

export function createForkAcpSessionBindingStore(dbPath: string): ForkAcpSessionBindingStore {
  const withDatabase = async <T>(run: (db: DatabaseSync) => T): Promise<T> => {
    const db = new DatabaseSync(dbPath, { timeout: SESSION_DB_BUSY_TIMEOUT_MS });
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  const configCache = new Map<string, ForkAcpSessionConfig>();
  // A read started before a write must not be cached after it. Every write bumps the version.
  let writeVersion = 0;
  const written = (sessionId: string): void => {
    writeVersion += 1;
    configCache.delete(sessionId);
  };
  const readConfigFromDatabase = async (sessionId: string): Promise<ForkAcpSessionConfig> => {
    const version = writeVersion;
    const config = await withDatabase((db) => {
      const row = readConfigRow(db, sessionId);
      return {
        agentId: row?.agent_id,
        offered: parseOffered(row?.config_options ?? null),
        choices: parseChoices(row?.config_choices ?? null),
      };
    });
    if (version === writeVersion) {
      if (configCache.size >= CONFIG_CACHE_LIMIT) {
        const oldest = configCache.keys().next();
        if (!oldest.done) configCache.delete(oldest.value);
      }
      configCache.set(sessionId, config);
    }
    return config;
  };
  return {
    read: (sessionId) =>
      withDatabase((db) => {
        const row = db
          .prepare(
            "select agent_id, acp_session_id, cwd, launch_key from fork_acp_session_binding where session_id = ?",
          )
          .get(sessionId) as BindingRow | undefined;
        if (row === undefined) return undefined;
        return {
          agentId: row.agent_id,
          acpSessionId: row.acp_session_id,
          cwd: row.cwd,
          launchKey: row.launch_key,
        };
      }),
    write: async (sessionId, binding) => {
      await withDatabase((db) => {
        db.prepare(
          `insert into fork_acp_session_binding
             (session_id, agent_id, acp_session_id, cwd, launch_key, updated_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict(session_id) do update set
             agent_id = excluded.agent_id,
             acp_session_id = excluded.acp_session_id,
             cwd = excluded.cwd,
             launch_key = excluded.launch_key,
             updated_at = excluded.updated_at`,
        ).run(
          sessionId,
          binding.agentId,
          binding.acpSessionId,
          binding.cwd,
          binding.launchKey,
          Date.now(),
        );
      });
      written(sessionId);
    },
    clear: async (sessionId) => {
      await withDatabase((db) => {
        db.prepare("delete from fork_acp_session_binding where session_id = ?").run(sessionId);
      });
      written(sessionId);
    },
    readConfig: (sessionId) => {
      const cached = configCache.get(sessionId);
      return cached === undefined ? readConfigFromDatabase(sessionId) : Promise.resolve(cached);
    },
    writeOffered: async (sessionId, options) => {
      await withDatabase((db) => {
        db.prepare(
          "update fork_acp_session_binding set config_options = ?, updated_at = ? where session_id = ?",
        ).run(JSON.stringify(options), Date.now(), sessionId);
      });
      written(sessionId);
    },
    writeChoice: async (sessionId, configId, value) => {
      await withDatabase((db) => {
        // Read-modify-write under one write lock, so two choices never overwrite each other.
        db.exec("begin immediate");
        try {
          const row = readConfigRow(db, sessionId);
          if (row !== undefined) {
            const choices = { ...parseChoices(row.config_choices), [configId]: value };
            db.prepare(
              "update fork_acp_session_binding set config_choices = ?, updated_at = ? where session_id = ?",
            ).run(JSON.stringify(choices), Date.now(), sessionId);
          }
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      });
      written(sessionId);
    },
  };
}

function readConfigRow(db: DatabaseSync, sessionId: string): ConfigRow | undefined {
  return db
    .prepare(
      "select agent_id, config_options, config_choices from fork_acp_session_binding where session_id = ?",
    )
    .get(sessionId) as ConfigRow | undefined;
}

/** A malformed stored value is treated as absent: the next turn writes a fresh snapshot. */
function parseOffered(text: string | null): readonly ExternalAgentConfigOption[] | undefined {
  if (text === null) return undefined;
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || !parsed.every(isConfigOption)) return undefined;
  return parsed;
}

function parseChoices(text: string | null): Readonly<Record<string, string>> {
  if (text === null) return {};
  const parsed = parseJson(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const choices: Record<string, string> = {};
  for (const [configId, value] of Object.entries(parsed)) {
    if (typeof value === "string") choices[configId] = value;
  }
  return choices;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isConfigOption(value: unknown): value is ExternalAgentConfigOption {
  if (value === null || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.id === "string" &&
    typeof option.name === "string" &&
    isNullableString(option.description) &&
    isNullableString(option.category) &&
    typeof option.currentValue === "string" &&
    Array.isArray(option.options) &&
    option.options.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;
      return (
        typeof item.value === "string" &&
        typeof item.name === "string" &&
        isNullableString(item.description) &&
        isNullableString(item.group)
      );
    })
  );
}
