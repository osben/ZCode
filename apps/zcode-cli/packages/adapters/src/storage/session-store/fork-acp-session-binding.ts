/**
 * Fork-owned ACP session binding per ZCode session (specs/acp-agent-runtime.md "S5"). The row names the
 * ACP session an external agent can resume (`session/load`) after a cold start or a restart. It lives in
 * `fork_acp_session_binding` (migration 9003), so upstream session repositories never read it.
 *
 * Each call opens the session database for itself: a binding is read and written a few times per turn,
 * and no connection outlives the call.
 */
import { DatabaseSync } from "node:sqlite";

/** Lock wait for a busy session database; longer than any single write the session store makes. */
const SESSION_DB_BUSY_TIMEOUT_MS = 5_000;

export interface ForkAcpSessionBinding {
  readonly agentId: string;
  readonly acpSessionId: string;
  readonly cwd: string;
  /** Digest of the launch config the ACP session was created under; never the config itself. */
  readonly launchKey: string;
}

export interface ForkAcpSessionBindingStore {
  read(sessionId: string): Promise<ForkAcpSessionBinding | undefined>;
  write(sessionId: string, binding: ForkAcpSessionBinding): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

interface BindingRow {
  agent_id: string;
  acp_session_id: string;
  cwd: string;
  launch_key: string;
}

export function createForkAcpSessionBindingStore(dbPath: string): ForkAcpSessionBindingStore {
  const withDatabase = async <T>(run: (db: DatabaseSync) => T): Promise<T> => {
    const db = new DatabaseSync(dbPath, { timeout: SESSION_DB_BUSY_TIMEOUT_MS });
    try {
      return run(db);
    } finally {
      db.close();
    }
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
    write: (sessionId, binding) =>
      withDatabase((db) => {
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
      }),
    clear: (sessionId) =>
      withDatabase((db) => {
        db.prepare("delete from fork_acp_session_binding where session_id = ?").run(sessionId);
      }),
  };
}
