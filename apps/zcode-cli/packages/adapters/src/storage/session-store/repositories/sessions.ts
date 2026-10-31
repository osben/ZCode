import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  SESSION_TASK_TYPES,
  type ChildSessionInfo,
  type ClaimLegacySessionWorkspaceInput,
  type CreateSessionInput,
  type FileDiff,
  type ListSessionsInput,
  type RepairLegacyRemoteSessionWorkspaceInput,
  type RepairRemoteSessionPathsInput,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type UpdateSessionInput,
  type SessionTaskType,
} from "@zcode/contracts";
import { decodeSessionRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionRow } from "../rows.js";

export function createSession(db: DatabaseSync, input: CreateSessionInput): SessionInfo {
  const now = Date.now();
  const timeCreated = input.time?.created ?? now;
  const timeUpdated = input.time?.updated ?? timeCreated;

  db.prepare(
    `
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        execution_directory, execution_branch, fork_incognito,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting, time_archived
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        execution_directory = coalesce(session.execution_directory, excluded.execution_directory),
        execution_branch = coalesce(session.execution_branch, excluded.execution_branch),
        fork_incognito = coalesce(session.fork_incognito, excluded.fork_incognito),
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.projectID,
    input.workspaceID ?? null,
    input.parentID ?? null,
    input.traceID ?? null,
    input.taskType ?? "interactive",
    input.slug,
    input.directory,
    input.path ?? null,
    input.executionDirectory ?? null,
    input.executionBranch ?? null,
    encodeJson(input.incognito),
    input.title,
    input.titleSource ?? "first_input",
    input.titleMessageID ?? null,
    input.version,
    input.shareURL ?? null,
    encodeJson(input.permission),
    timeCreated,
    timeUpdated,
    input.titleSource || input.titleMessageID ? timeUpdated : null,
  );

  return mustGetSession(db, input.id);
}

export function deleteEmptySession(db: DatabaseSync, sessionID: SessionId): boolean {
  const result = db
    .prepare(
      `
      delete from session
      where id = ?
        and not exists (select 1 from message where session_id = ?)
        and not exists (select 1 from session_entry where session_id = ?)
        and not exists (select 1 from session_input where session_id = ?)
      `,
    )
    .run(sessionID, sessionID, sessionID, sessionID);
  return Number(result.changes) > 0;
}

export async function updateSession(
  db: DatabaseSync,
  input: UpdateSessionInput,
): Promise<SessionInfo> {
  const fields: string[] = [];
  const values: SQLInputValue[] = [];
  const set = (column: string, value: SQLInputValue | undefined) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
  };
  // Only the columns owned by this input are written: a read-then-write of the whole row lets a
  // concurrent title, permission or outcome update be overwritten with the stale snapshot.
  set("directory", input.directory);
  set("path", input.path);
  set("title", input.title);
  set("title_source", input.titleSource);
  set("title_message_id", input.titleMessageID);
  set("share_url", input.shareURL);
  set("last_outcome", input.lastOutcome);
  if (input.summary !== undefined) {
    set("summary_additions", input.summary?.additions ?? null);
    set("summary_deletions", input.summary?.deletions ?? null);
    set("summary_files", input.summary?.files ?? null);
    set("summary_diffs", encodeJson(input.summary?.diffs));
  }
  if (input.revert !== undefined) set("revert", encodeJson(input.revert));
  if (input.permission !== undefined) set("permission", encodeJson(input.permission));
  set("time_compacting", input.timeCompacting);
  if (
    input.title !== undefined ||
    input.titleSource !== undefined ||
    input.titleMessageID !== undefined
  ) {
    set("time_title_updated", Date.now());
  }
  // Title and organization state are not session activity; activity is committed explicitly by
  // messages or terminal states, and never moves backwards.
  if (input.timeUpdated !== undefined) {
    fields.push("time_updated = max(time_updated, ?)");
    values.push(input.timeUpdated);
  }
  if (fields.length) {
    values.push(input.id);
    const sources = input.title !== undefined ? input.expectedTitleSources : undefined;
    const guard = sources?.length
      ? ` and coalesce(title_source, 'first_input') in (${sources.map(() => "?").join(",")})`
      : "";
    if (sources?.length) values.push(...sources);
    db.prepare(`update session set ${fields.join(",")} where id=?${guard}`).run(...values);
  }
  return mustGetSession(db, input.id);
}

/** Upstream tombstone: idempotent, keeps message/part rows and the activity time; listings hide it. */
export function softDeleteSession(
  db: DatabaseSync,
  sessionID: SessionId,
  timeDeleted: number,
): void {
  db.prepare("update session set time_deleted = coalesce(time_deleted, ?) where id = ?").run(
    timeDeleted,
    sessionID,
  );
}

/**
 * Expand descendants only along "attached sessions": subagent / workflow / side-chat child
 * sessions exist as long as their parent does. A fork's parent_id also points at the source
 * session, but a fork is a user-visible independent task (possibly already filed under another
 * project) and must never be cascade-deleted with the source; interactive / workflow_parent are
 * likewise not expanded.
 */
const OWNED_CHILD_TASK_TYPES: readonly SessionTaskType[] = [
  "selection_side_chat",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
];
const SQL_ID_CHUNK = 400;

function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += SQL_ID_CHUNK)
    chunks.push(items.slice(index, index + SQL_ID_CHUNK));
  return chunks;
}

/** Each root session → the root itself plus all attached descendants; an empty array when the root does not exist. */
export function listOwnedSessionTrees(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const exists = db.prepare("select 1 from session where id = ?");
  const children = db.prepare(
    `select id from session where parent_id = ? and task_type in (${OWNED_CHILD_TASK_TYPES.map(() => "?").join(",")})
     union select child_session_id as id from session_task_link where parent_session_id = ?`,
  );
  const trees = new Map<SessionId, SessionId[]>();
  for (const root of sessionIDs) {
    if (!exists.get(root)) {
      trees.set(root, []);
      continue;
    }
    const seen = new Set<SessionId>([root]);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const row of children.all(current, ...OWNED_CHILD_TASK_TYPES, current) as Array<{
        id: SessionId;
      }>) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        queue.push(row.id);
      }
    }
    trees.set(root, [...seen]);
  }
  return trees;
}

const ARTIFACT_URI_SCHEME = "zcode-artifact://";
const ARTIFACT_URI_SESSION = /zcode-artifact:\/\/([^/"\\\s]+)\//g;

/**
 * Each target session → other undeleted sessions still referencing its artifacts
 * (`zcode-artifact://<target>/…`). Forks, rewinds, and workflow transcripts copy parts by value
 * while URIs still point into the source session's artifact directory; detection works on part
 * content, independent of fork lineage, so any copy path is covered. Called only on hard delete;
 * a single full-table scan is acceptable.
 */
export function listArtifactReferrers(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const targets = new Set<string>(sessionIDs);
  const referrers = new Map<SessionId, Set<SessionId>>();
  if (!targets.size) return new Map();
  const rows = db
    .prepare(
      `select p.session_id, p.data from part p join session s on s.id = p.session_id
       where s.time_deleted is null and instr(p.data, ?) > 0`,
    )
    .iterate(ARTIFACT_URI_SCHEME) as Iterable<{ session_id: SessionId; data: string }>;
  for (const row of rows) {
    for (const match of row.data.matchAll(ARTIFACT_URI_SESSION)) {
      const target = decodeURIComponent(match[1]!) as SessionId;
      if (target === row.session_id || !targets.has(target)) continue;
      referrers.set(target, (referrers.get(target) ?? new Set()).add(row.session_id));
    }
  }
  return new Map([...referrers].map(([target, ids]) => [target, [...ids]]));
}

/**
 * Hard-delete all rows of the given sessions and their attached descendants. message/part/todo/
 * usage cascade via foreign keys; input_history, dwf_run, workflow_run have no cascading foreign
 * key to session and must be deleted explicitly or they leave orphan rows. The caller deletes the
 * session files first: on file failure this function is not called, so the next retry can still
 * find them via the session.
 */
export function purgeSessions(db: DatabaseSync, sessionIDs: readonly SessionId[]): void {
  const ids = [...new Set([...listOwnedSessionTrees(db, sessionIDs).values()].flat())];
  if (!ids.length) return;
  // foreign_keys cannot be toggled inside a transaction; it was enabled at startup — ensure cascades are in effect once more.
  db.exec("pragma foreign_keys = on");
  db.exec("begin immediate");
  try {
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      db.prepare(`delete from input_history where session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from dwf_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from workflow_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from session where id in (${marks})`).run(...chunk);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function getSession(db: DatabaseSync, sessionID: SessionId): SessionInfo | null {
  const row = db.prepare("select * from session where id = ?").get(sessionID) as
    | SessionRow
    | undefined;
  return row ? decodeSessionRow(row) : null;
}

export async function listSessions(
  db: DatabaseSync,
  input: ListSessionsInput = {},
): Promise<SessionInfo[]> {
  // Soft-deleted (tombstoned) sessions are hidden from every listing.
  const clauses: string[] = ["time_deleted is null"];
  const values: SQLInputValue[] = [];

  if (input.projectID) {
    clauses.push("project_id = ?");
    values.push(input.projectID);
  }

  if (input.workspaceID !== undefined) {
    if (input.workspaceID === null) {
      clauses.push("workspace_id is null");
    } else {
      clauses.push("workspace_id = ?");
      values.push(input.workspaceID);
    }
  }

  if (input.directory) {
    clauses.push("directory = ?");
    values.push(input.directory);
  }

  if (input.path !== undefined) {
    if (input.path.length === 0) {
      clauses.push("(path is null or path = '')");
    } else {
      clauses.push("(path = ? or path like ?)");
      values.push(input.path, `${input.path}/%`);
    }
  }

  if (input.roots) {
    clauses.push("parent_id is null");
  }

  const taskTypes = normalizeSessionTaskTypes(input.taskTypes);
  if (taskTypes.length > 0) {
    clauses.push(`task_type in (${taskTypes.map(() => "?").join(", ")})`);
    values.push(...taskTypes);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitValue = input.limit && input.limit > 0 ? input.limit : undefined;
  const limit = limitValue === undefined ? "" : " limit ?";
  if (limitValue !== undefined) {
    values.push(limitValue);
  }
  const rows = db
    .prepare(`select * from session ${where} order by time_updated desc, id desc${limit}`)
    .all(...values) as unknown as SessionRow[];
  return rows.map(decodeSessionRow);
}

/** Sidebar child facts cover exactly these task types (specs/sidebar-child-conversation-counts.md). */
// Sidebar lists side chats only (spec sidebar-child-conversation-counts §9): subagents are reached from the parent conversation.
const CHILD_SESSION_TASK_TYPES = ["selection_side_chat"] as const;

function buildChildSessionScope(parentIds: readonly SessionId[]): {
  where: string;
  values: SQLInputValue[];
} {
  return {
    where: `parent_id in (${parentIds.map(() => "?").join(", ")}) and task_type in (${CHILD_SESSION_TASK_TYPES.map(() => "?").join(", ")}) and time_deleted is null`,
    values: [...parentIds, ...CHILD_SESSION_TASK_TYPES],
  };
}

export function countChildSessions(
  db: DatabaseSync,
  parentIds: readonly SessionId[],
): Map<string, { sideChats: number }> {
  const result = new Map<string, { sideChats: number }>();
  if (parentIds.length === 0) return result;
  const scope = buildChildSessionScope(parentIds);
  const rows = db
    .prepare(`select parent_id, count(*) as n from session where ${scope.where} group by parent_id`)
    .all(...scope.values) as unknown as Array<{ parent_id: string; n: number }>;
  for (const row of rows) result.set(row.parent_id, { sideChats: row.n });
  return result;
}

export function listChildSessions(
  db: DatabaseSync,
  parentIds: readonly SessionId[],
  limitPerParent: number,
): Map<string, ChildSessionInfo[]> {
  const result = new Map<string, ChildSessionInfo[]>();
  if (parentIds.length === 0 || limitPerParent <= 0) return result;
  const scope = buildChildSessionScope(parentIds);
  // Cap in SQL (row_number per parent): without it every refresh decodes every live child row of
  // every tracked parent, which grows without bound as parents accumulate (spec §3 heat control).
  const rows = db
    .prepare(
      `select * from (
         select session.*, row_number() over (partition by parent_id order by time_updated desc, id desc) as child_rank
         from session where ${scope.where}
       ) where child_rank <= ?`,
    )
    .all(...scope.values, limitPerParent) as unknown as SessionRow[];
  for (const row of rows) {
    const info = decodeSessionRow(row);
    if (info.taskType !== "selection_side_chat") continue;
    const parentKey = String(info.parentID);
    const bucket = result.get(parentKey) ?? [];
    if (bucket.length >= limitPerParent) continue;
    bucket.push({
      id: info.id,
      title: info.title,
      taskType: info.taskType,
      lastActivityAt: info.time.updated,
    });
    result.set(parentKey, bucket);
  }
  return result;
}

export function claimLegacySessionWorkspace(
  db: DatabaseSync,
  input: ClaimLegacySessionWorkspaceInput,
): number {
  const sessionIDs = [...new Set(input.sessionIDs)];
  if (sessionIDs.length === 0) return 0;
  // SSH/WSL sessions from 3.3.6 have no workspace_id, while the 3.4 sessions index queries by the full
  // identity. This made all historical tasks invisible after upgrade. Accept only exact entries from the host tasks index
  // taskId allowlist, together with the actual directory and NULL identity; never fall back to bulk claims by path.
  const result = db
    .prepare(
      `update session
       set workspace_id = ?
       where workspace_id is null
         and directory = ?
         and id in (${sessionIDs.map(() => "?").join(", ")})`,
    )
    .run(input.workspaceID, input.directory, ...sessionIDs);
  return Number(result.changes);
}

export function repairLegacyRemoteSessionWorkspace(
  db: DatabaseSync,
  input: RepairLegacyRemoteSessionWorkspaceInput,
): boolean {
  // Version 3.4.2 treated the WSL identity as an execution path; production paths may also be path.resolve’d
  // against the real cwd before persistence. Migrate only an exact single session and full old directory; do not search ambiguously or claim in bulk.
  const result = db
    .prepare(
      `update session
       set project_id = ?, workspace_id = ?, directory = ?, path = ?
       where id = ?
         and workspace_id is null
         and directory = ?
         and (path is null or path = ?)`,
    )
    .run(
      input.projectID,
      input.workspaceID,
      input.workspacePath,
      input.workspacePath,
      input.sessionID,
      input.legacyWorkspaceDirectory,
      input.legacyWorkspaceDirectory,
    );
  return Number(result.changes) === 1;
}

export function repairRemoteSessionPaths(
  db: DatabaseSync,
  input: RepairRemoteSessionPathsInput,
): boolean {
  // Path repair previously reused the full-field updateSession, overwriting concurrent title, permission, rollback, and
  // archive changes with values from the read snapshot. This maintenance migration may update only path fields and must use the old path for CAS.
  const result = db
    .prepare(
      `update session
       set directory = ?, path = ?, time_updated = max(time_updated, ?)
       where id = ?
         and workspace_id = ?
         and directory = ?
         and ((? is null and path is null) or path = ?)`,
    )
    .run(
      input.directory,
      input.path,
      input.timeUpdated,
      input.sessionID,
      input.workspaceID,
      input.expectedDirectory,
      input.expectedPath,
      input.expectedPath,
    );
  return Number(result.changes) === 1;
}

export async function setRevert(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  },
): Promise<void> {
  await updateSession(db, {
    id: input.sessionID,
    revert: input.revert,
    summary: input.summary
      ? {
          additions: input.summary.additions,
          deletions: input.summary.deletions,
          files: input.summary.files,
          diffs: input.summary.diffs,
        }
      : undefined,
  });
}

export async function clearRevert(db: DatabaseSync, sessionID: SessionId): Promise<void> {
  await updateSession(db, {
    id: sessionID,
    revert: null,
    summary: null,
  });
}

export function touchSession(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

function normalizeSessionTaskTypes(taskTypes: readonly SessionTaskType[] | undefined): string[] {
  if (!taskTypes || taskTypes.length === 0) return [];
  const valid = new Set<string>(SESSION_TASK_TYPES);
  return [...new Set(taskTypes.filter((taskType) => valid.has(taskType)))];
}

function mustGetSession(db: DatabaseSync, sessionID: SessionId): SessionInfo {
  const session = getSession(db, sessionID);
  if (!session) {
    throw new Error(`Session not found after write: ${sessionID}`);
  }
  return session;
}
