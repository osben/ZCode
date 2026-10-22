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
const CHILD_SESSION_TASK_TYPES = ["selection_side_chat", "subagent_child"] as const;

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
): Map<string, { sideChats: number; subagents: number }> {
  const result = new Map<string, { sideChats: number; subagents: number }>();
  if (parentIds.length === 0) return result;
  const scope = buildChildSessionScope(parentIds);
  const rows = db
    .prepare(
      `select parent_id, task_type, count(*) as n from session where ${scope.where} group by parent_id, task_type`,
    )
    .all(...scope.values) as unknown as Array<{ parent_id: string; task_type: string; n: number }>;
  for (const row of rows) {
    const entry = result.get(row.parent_id) ?? { sideChats: 0, subagents: 0 };
    if (row.task_type === "selection_side_chat") entry.sideChats += row.n;
    else entry.subagents += row.n;
    result.set(row.parent_id, entry);
  }
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
    if (info.taskType !== "selection_side_chat" && info.taskType !== "subagent_child") continue;
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
