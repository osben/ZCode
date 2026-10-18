// Permanent erase of a session tree (specs/session-deletion-cascade.md §4-§5).
// A plain `delete from session` is not enough: workflow_run and session_task_link reference sessions with
// `on delete set null`, dwf_* and input_history carry session ids without a foreign key, and parent_id has none
// either. This module resolves the tree explicitly and deletes the non-cascading rows first.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  SESSION_TREE_CHILD_TASK_TYPES,
  type SessionId,
  type SessionTreeCounts,
} from "@zcode/contracts";

/** Keeps every statement far below SQLite's bound-variable limit. */
const ID_CHUNK_SIZE = 400;

function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += ID_CHUNK_SIZE) {
    chunks.push(items.slice(index, index + ID_CHUNK_SIZE));
  }
  return chunks;
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

/**
 * Roots that exist plus descendants through SESSION_TREE_CHILD_TASK_TYPES (archived included).
 * Forks and interactive sessions share parent_id but are never walked into.
 */
function resolveTreeIds(db: DatabaseSync, rootIds: readonly SessionId[]): Map<string, string> {
  const tree = new Map<string, string>();
  const uniqueRoots = [...new Set(rootIds.map(String))];
  const typePlaceholders = placeholders(SESSION_TREE_CHILD_TASK_TYPES.length);
  for (const roots of chunk(uniqueRoots)) {
    const rows = db
      .prepare(
        `with recursive tree(id, task_type) as (
           select id, task_type from session where id in (${placeholders(roots.length)})
           union
           select s.id, s.task_type from session s join tree t on s.parent_id = t.id
           where s.task_type in (${typePlaceholders})
         )
         select id, task_type from tree`,
      )
      .all(...roots, ...SESSION_TREE_CHILD_TASK_TYPES) as unknown as Array<{
      id: string;
      task_type: string;
    }>;
    for (const row of rows) tree.set(row.id, row.task_type);
  }
  return tree;
}

function countByIds(
  db: DatabaseSync,
  ids: readonly string[],
  sql: (placeholderList: string) => string,
  extraValues: SQLInputValue[] = [],
): number {
  let total = 0;
  for (const part of chunk(ids)) {
    const row = db.prepare(sql(placeholders(part.length))).get(...part, ...extraValues) as unknown as {
      n: number;
    };
    total += Number(row.n);
  }
  return total;
}

export function listSessionTreeIds(db: DatabaseSync, rootIds: readonly SessionId[]): SessionId[] {
  return [...resolveTreeIds(db, rootIds).keys()] as SessionId[];
}

/** Tree sessions with a child outside the tree, i.e. a fork whose copied parts still point at their files. */
export function listSessionTreeIdsWithSurvivingChildren(
  db: DatabaseSync,
  rootIds: readonly SessionId[],
): SessionId[] {
  const tree = resolveTreeIds(db, rootIds);
  const retained = new Set<string>();
  for (const ids of chunk([...tree.keys()])) {
    const rows = db
      .prepare(
        `select id, parent_id from session where parent_id in (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as Array<{ id: string; parent_id: string }>;
    for (const row of rows) {
      if (!tree.has(row.id)) retained.add(row.parent_id);
    }
  }
  return [...retained] as SessionId[];
}

export function countSessionTree(
  db: DatabaseSync,
  rootIds: readonly SessionId[],
): SessionTreeCounts {
  const tree = resolveTreeIds(db, rootIds);
  const ids = [...tree.keys()];
  let sideChats = 0;
  let subagents = 0;
  let workflowSessions = 0;
  for (const taskType of tree.values()) {
    if (taskType === "selection_side_chat") sideChats += 1;
    else if (taskType === "subagent_child") subagents += 1;
    else if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
      workflowSessions += 1;
    }
  }
  const scriptRuns = countByIds(
    db,
    ids,
    (list) => `select count(*) as n from workflow_run where parent_session_id in (${list})`,
  );
  const dwfRuns = countByIds(
    db,
    ids,
    (list) => `select count(*) as n from dwf_run where parent_session_id in (${list})`,
  );
  return {
    total: ids.length,
    sideChats,
    subagents,
    workflowSessions,
    workflowRuns: scriptRuns + dwfRuns,
  };
}

export function deleteSessionTree(
  db: DatabaseSync,
  rootIds: readonly SessionId[],
): { erasedIds: SessionId[] } {
  db.exec("begin immediate");
  try {
    // Resolve inside the write transaction so a concurrent writer cannot add a child between
    // resolution and deletion and leave it orphaned.
    const ids = [...resolveTreeIds(db, rootIds).keys()];
    for (const part of chunk(ids)) {
      const list = placeholders(part.length);
      // Order matters: the workflow rows still need the session ids to be matched, and deleting
      // the sessions first would null the references (`on delete set null`) that identify them.
      // Cascades workflow_activity / workflow_event / session_task_link rows of the run.
      db.prepare(`delete from workflow_run where parent_session_id in (${list})`).run(...part);
      db.prepare(`delete from dwf_run where parent_session_id in (${list})`).run(...part);
      db.prepare(`delete from input_history where session_id in (${list})`).run(...part);
      db.prepare(`delete from session where id in (${list})`).run(...part);
    }
    db.exec("commit");
    return { erasedIds: ids as SessionId[] };
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  }
}
