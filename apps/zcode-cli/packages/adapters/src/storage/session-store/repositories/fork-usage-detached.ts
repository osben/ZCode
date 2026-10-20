import { syncModelRows, syncToolRows } from "./fork-usage-protected-rows.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import { ensureForkUsageDetachedSchema } from "./fork-usage-detached-schema.js";
import { FORK_USAGE_BUCKET_MS } from "./fork-usage-rollup-schema.js";

/**
 * Detach session-scoped turn identities and move model/tool rollups into protected baselines.
 * The whole operation is called inside deleteSessionTree's write transaction.
 */
export function preserveUsageBeforeSessionTreeDelete(
  db: DatabaseSync,
  sessionIds: readonly SessionId[],
): void {
  if (sessionIds.length === 0) return;
  ensureForkUsageDetachedSchema(db);
  syncForkUsageProtectedRawRows(db);
  protectModelRollups(db, sessionIds);
  protectToolRollups(db, sessionIds);
  snapshotProtectedModelRows(db);
  snapshotProtectedToolRows(db);
  detachTurnRows(db, sessionIds);
  // Raw tool IDs can embed a session ID. Once content is deleted, retain no snapshot linking it.
  for (const ids of chunks(sessionIds.map(String), 400)) {
    const list = ids.map(() => "?").join(", ");
    db.prepare(`delete from fork_usage_protected_model_raw where raw_id in (
      select id from model_usage where session_id in (${list}))`).run(...ids);
    db.prepare(`delete from fork_usage_protected_tool_raw where raw_id in (
      select id from tool_usage where session_id in (${list}))`).run(...ids);
  }
}

/** Reconcile writes made by another process before a read or a normal rollup recompute. */
export function syncForkUsageProtectedRawRows(db: DatabaseSync): void {
  ensureForkUsageDetachedSchema(db);
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("begin immediate");
  try {
    // Raw retention removes provenance, never its preserved aggregate contribution.
    db.exec(
      "delete from fork_usage_protected_model_raw where raw_id not in (select id from model_usage)",
    );
    db.exec(
      "delete from fork_usage_protected_tool_raw where raw_id not in (select id from tool_usage)",
    );
    syncModelRows(db);
    syncToolRows(db);
    if (ownTransaction) db.exec("commit");
  } catch (error) {
    if (ownTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* Preserve the original failure. */
      }
    }
    throw error;
  }
}

function protectModelRollups(db: DatabaseSync, sessionIds: readonly SessionId[]): void {
  for (const ids of chunks(sessionIds.map(String), 400)) {
    const list = ids.map(() => "?").join(", ");
    db.prepare(`insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, provider_id, model_id, query_source
    ) select 'model', cast(m.started_at / ? as integer) * ?, coalesce(s.directory, ''),
      m.provider_id, coalesce(m.model_id, ''), m.query_source
      from model_usage m left join session s on s.id = m.session_id where m.session_id in (${list})`).run(
      FORK_USAGE_BUCKET_MS,
      FORK_USAGE_BUCKET_MS,
      ...ids,
    );
    db.prepare(`insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, provider_id, model_id, query_source
    ) select 'model', b.bucket_start, b.workspace_key, b.provider_id, b.model_id, b.query_source
      from fork_usage_bucket b where exists (
        select 1 from fork_usage_turn t where t.session_id in (${list})
          and t.bucket_start = b.bucket_start and t.workspace_key = b.workspace_key
      )`).run(...ids);
  }
  db.exec(`
    insert or ignore into fork_usage_protected_model
    select b.* from fork_usage_bucket b where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='model'
        and p.bucket_start=b.bucket_start and p.workspace_key=b.workspace_key
        and p.provider_id=b.provider_id and p.model_id=b.model_id and p.query_source=b.query_source
    );
    delete from fork_usage_bucket where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='model'
        and p.bucket_start=fork_usage_bucket.bucket_start and p.workspace_key=fork_usage_bucket.workspace_key
        and p.provider_id=fork_usage_bucket.provider_id and p.model_id=fork_usage_bucket.model_id
        and p.query_source=fork_usage_bucket.query_source
    );
  `);
  initializeMissingProtectedModelsFromRaw(db);
}

function protectToolRollups(db: DatabaseSync, sessionIds: readonly SessionId[]): void {
  for (const ids of chunks(sessionIds.map(String), 400)) {
    const list = ids.map(() => "?").join(", ");
    db.prepare(`insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, tool_name
    ) select 'tool', cast(u.started_at / ? as integer) * ?, coalesce(s.directory, ''), u.tool_name
      from tool_usage u left join session s on s.id=u.session_id where u.session_id in (${list})`).run(
      FORK_USAGE_BUCKET_MS,
      FORK_USAGE_BUCKET_MS,
      ...ids,
    );
    db.prepare(`insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, tool_name
    ) select 'tool', u.bucket_start, u.workspace_key, u.tool_name from fork_usage_tool u where exists (
      select 1 from fork_usage_turn t where t.session_id in (${list})
        and t.bucket_start=u.bucket_start and t.workspace_key=u.workspace_key
    )`).run(...ids);
  }
  db.exec(`
    insert or ignore into fork_usage_protected_tool
    select u.* from fork_usage_tool u where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='tool'
        and p.bucket_start=u.bucket_start and p.workspace_key=u.workspace_key and p.tool_name=u.tool_name
    );
    delete from fork_usage_tool where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='tool'
        and p.bucket_start=fork_usage_tool.bucket_start and p.workspace_key=fork_usage_tool.workspace_key
        and p.tool_name=fork_usage_tool.tool_name
    );
  `);
  initializeMissingProtectedToolsFromRaw(db);
}

function initializeMissingProtectedModelsFromRaw(db: DatabaseSync): void {
  db.exec(`insert or ignore into fork_usage_protected_model
    select cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS},
      coalesce(s.directory, ''), m.provider_id, coalesce(m.model_id, ''), m.query_source,
      coalesce(sum(m.input_tokens), 0), coalesce(sum(m.output_tokens), 0),
      coalesce(sum(m.reasoning_tokens), 0), coalesce(sum(m.cache_creation_input_tokens), 0),
      coalesce(sum(m.cache_read_input_tokens), 0), coalesce(sum(m.computed_total_tokens), 0), count(*),
      sum(case when m.status='error' then 1 else 0 end),
      coalesce(sum(m.time_to_first_token_ms), 0), count(m.time_to_first_token_ms)
    from model_usage m left join session s on s.id=m.session_id
    where exists (select 1 from fork_usage_protected_bucket p where p.kind='model'
      and p.bucket_start=cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
      and p.workspace_key=coalesce(s.directory, '') and p.provider_id=m.provider_id
      and p.model_id=coalesce(m.model_id, '') and p.query_source=m.query_source)
    group by 1,2,3,4,5`);
}

function initializeMissingProtectedToolsFromRaw(db: DatabaseSync): void {
  db.exec(`insert or ignore into fork_usage_protected_tool
    select cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS},
      coalesce(s.directory, ''), u.tool_name, count(*), sum(case when u.status='error' then 1 else 0 end),
      coalesce(sum(u.duration_ms), 0), count(u.duration_ms)
    from tool_usage u left join session s on s.id=u.session_id
    where exists (select 1 from fork_usage_protected_bucket p where p.kind='tool'
      and p.bucket_start=cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
      and p.workspace_key=coalesce(s.directory, '') and p.tool_name=u.tool_name)
    group by 1,2,3`);
}

function snapshotProtectedModelRows(db: DatabaseSync): void {
  db.exec(`
    insert or ignore into fork_usage_protected_model_raw
    select m.id, cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS},
      coalesce(s.directory, ''), m.provider_id, coalesce(m.model_id, ''), m.query_source,
      coalesce(m.input_tokens, 0), coalesce(m.output_tokens, 0), coalesce(m.reasoning_tokens, 0),
      coalesce(m.cache_creation_input_tokens, 0), coalesce(m.cache_read_input_tokens, 0),
      coalesce(m.computed_total_tokens, 0), case when m.status = 'error' then 1 else 0 end,
      m.time_to_first_token_ms
    from model_usage m left join session s on s.id = m.session_id
    where exists (
      select 1 from fork_usage_protected_bucket p
      where p.kind = 'model'
        and p.bucket_start = cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
        and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
        and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
    );
  `);
}

function snapshotProtectedToolRows(db: DatabaseSync): void {
  db.exec(`
    insert or ignore into fork_usage_protected_tool_raw
    select u.id, cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS},
      coalesce(s.directory, ''), u.tool_name,
      case when u.status = 'error' then 1 else 0 end, u.duration_ms
    from tool_usage u left join session s on s.id = u.session_id
    where exists (
      select 1 from fork_usage_protected_bucket p
      where p.kind = 'tool'
        and p.bucket_start = cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
        and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
    );
  `);
}

function detachTurnRows(db: DatabaseSync, sessionIds: readonly SessionId[]): void {
  const opaqueBySession = new Map(sessionIds.map((id) => [String(id), randomUUID()]));
  const insert = db.prepare(`
    insert into fork_usage_detached_turn (
      bucket_start, opaque_session_id, workspace_key, turn_count,
      completed_duration_sum_ms, completed_count, total_tokens
    )
    select bucket_start, ?, workspace_key, turn_count, completed_duration_sum_ms, completed_count,
      total_tokens from fork_usage_turn where session_id = ?
    on conflict(bucket_start, opaque_session_id) do update set
      workspace_key = excluded.workspace_key, turn_count = excluded.turn_count,
      completed_duration_sum_ms = excluded.completed_duration_sum_ms,
      completed_count = excluded.completed_count, total_tokens = excluded.total_tokens
  `);
  for (const ids of chunks([...opaqueBySession.keys()], 400)) {
    const rows = db
      .prepare(
        `select distinct session_id from fork_usage_turn where session_id in (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as Array<{ session_id: string }>;
    for (const row of rows) insert.run(opaqueBySession.get(row.session_id)!, row.session_id);
    db.prepare(
      `delete from fork_usage_turn where session_id in (${ids.map(() => "?").join(", ")})`,
    ).run(...ids);
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
