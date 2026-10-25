import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { FORK_USAGE_BUCKET_MS } from "./fork-usage-rollup-schema.js";

interface ModelRawRow {
  id: string;
  bucket_start: number;
  workspace_key: string;
  provider_id: string;
  model_id: string;
  query_source: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  computed_total_tokens: number;
  is_error: number;
  ttft_ms: number | null;
}

interface ToolRawRow {
  id: string;
  bucket_start: number;
  workspace_key: string;
  tool_name: string;
  is_error: number;
  duration_ms: number | null;
}

const MODEL_KEYS = [
  "bucket_start",
  "workspace_key",
  "provider_id",
  "model_id",
  "query_source",
] as const;
const TOOL_KEYS = ["bucket_start", "workspace_key", "tool_name"] as const;

export function syncModelRows(db: DatabaseSync): void {
  const rows = db
    .prepare(`
    select m.id, cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS} as bucket_start,
      coalesce(s.directory, '') as workspace_key, m.provider_id, coalesce(m.model_id, '') as model_id,
      m.query_source, coalesce(m.input_tokens, 0) as input_tokens,
      coalesce(m.output_tokens, 0) as output_tokens, coalesce(m.reasoning_tokens, 0) as reasoning_tokens,
      coalesce(m.cache_creation_input_tokens, 0) as cache_creation_tokens,
      coalesce(m.cache_read_input_tokens, 0) as cache_read_tokens,
      coalesce(m.computed_total_tokens, 0) as computed_total_tokens,
      case when m.status = 'error' then 1 else 0 end as is_error,
      m.time_to_first_token_ms as ttft_ms
    from model_usage m left join session s on s.id = m.session_id
    left join fork_usage_protected_model_raw r on r.raw_id = m.id
    where r.raw_id is not null or exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'model'
        and p.bucket_start = cast(m.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
        and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
        and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
    )
  `)
    .all() as unknown as ModelRawRow[];
  const oldById = new Map(
    (
      db
        .prepare("select raw_id as id, * from fork_usage_protected_model_raw")
        .all() as unknown as ModelRawRow[]
    ).map((row) => [row.id, row]),
  );
  const save = db.prepare(`insert into fork_usage_protected_model_raw (
    raw_id, bucket_start, workspace_key, provider_id, model_id, query_source, input_tokens,
    output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens, computed_total_tokens,
    is_error, ttft_ms
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(raw_id) do update set bucket_start=excluded.bucket_start, workspace_key=excluded.workspace_key,
    provider_id=excluded.provider_id, model_id=excluded.model_id, query_source=excluded.query_source,
    input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
    reasoning_tokens=excluded.reasoning_tokens, cache_creation_tokens=excluded.cache_creation_tokens,
    cache_read_tokens=excluded.cache_read_tokens, computed_total_tokens=excluded.computed_total_tokens,
    is_error=excluded.is_error, ttft_ms=excluded.ttft_ms`);
  for (const row of rows) {
    const old = oldById.get(row.id);
    if (old) applyModelDifference(db, old, row);
    else applyModelDifference(db, null, row);
    if (isProtectedModelRow(db, row)) save.run(...modelValues(row));
    else if (old)
      db.prepare("delete from fork_usage_protected_model_raw where raw_id = ?").run(row.id);
  }
}

export function syncToolRows(db: DatabaseSync): void {
  const rows = db
    .prepare(`
    select u.id, cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS} as bucket_start,
      coalesce(s.directory, '') as workspace_key, u.tool_name,
      case when u.status = 'error' then 1 else 0 end as is_error, u.duration_ms
    from tool_usage u left join session s on s.id = u.session_id
    left join fork_usage_protected_tool_raw r on r.raw_id = u.id
    where r.raw_id is not null or exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
        and p.bucket_start = cast(u.started_at / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}
        and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
    )
  `)
    .all() as unknown as ToolRawRow[];
  const oldById = new Map(
    (
      db
        .prepare("select raw_id as id, * from fork_usage_protected_tool_raw")
        .all() as unknown as ToolRawRow[]
    ).map((row) => [row.id, row]),
  );
  const save = db.prepare(`insert into fork_usage_protected_tool_raw
    (raw_id, bucket_start, workspace_key, tool_name, is_error, duration_ms) values (?, ?, ?, ?, ?, ?)
    on conflict(raw_id) do update set bucket_start=excluded.bucket_start,
      workspace_key=excluded.workspace_key, tool_name=excluded.tool_name,
      is_error=excluded.is_error, duration_ms=excluded.duration_ms`);
  for (const row of rows) {
    const old = oldById.get(row.id);
    applyToolDifference(db, old ?? null, row);
    if (isProtectedToolRow(db, row)) save.run(...toolValues(row));
    else if (old)
      db.prepare("delete from fork_usage_protected_tool_raw where raw_id = ?").run(row.id);
  }
}

function applyModelDifference(
  db: DatabaseSync,
  old: ModelRawRow | null,
  current: ModelRawRow,
): void {
  const sameGroup = old !== null && MODEL_KEYS.every((key) => old[key] === current[key]);
  if (!sameGroup) {
    if (old) applyModelDelta(db, old, -1);
    if (isProtectedModelRow(db, current)) applyModelDelta(db, current, 1);
    return;
  }
  if (isProtectedModelRow(db, current)) {
    applyModelDelta(
      db,
      combineModelDelta(old, current),
      1,
      0,
      Number(current.ttft_ms !== null) - Number(old.ttft_ms !== null),
    );
  }
}

function combineModelDelta(from: ModelRawRow, to: ModelRawRow): ModelRawRow {
  return {
    ...to,
    input_tokens: to.input_tokens - from.input_tokens,
    output_tokens: to.output_tokens - from.output_tokens,
    reasoning_tokens: to.reasoning_tokens - from.reasoning_tokens,
    cache_creation_tokens: to.cache_creation_tokens - from.cache_creation_tokens,
    cache_read_tokens: to.cache_read_tokens - from.cache_read_tokens,
    computed_total_tokens: to.computed_total_tokens - from.computed_total_tokens,
    is_error: to.is_error - from.is_error,
    ttft_ms: (to.ttft_ms ?? 0) - (from.ttft_ms ?? 0),
  };
}

function applyModelDelta(
  db: DatabaseSync,
  row: ModelRawRow,
  sign: number,
  requestCount = sign,
  ttftCount = sign * Number(row.ttft_ms !== null),
): void {
  db.prepare(`insert into fork_usage_protected_model (
    bucket_start, workspace_key, provider_id, model_id, query_source, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_tokens, cache_read_tokens, computed_total_tokens, request_count,
    model_error_count, ttft_sum_ms, ttft_count
  ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  where exists (select 1 from fork_usage_protected_bucket p where p.kind='model'
    and p.bucket_start=? and p.workspace_key=? and p.provider_id=? and p.model_id=? and p.query_source=?)
  on conflict(bucket_start, workspace_key, provider_id, model_id, query_source) do update set
    input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
    reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens,
    cache_creation_tokens=cache_creation_tokens+excluded.cache_creation_tokens,
    cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
    computed_total_tokens=computed_total_tokens+excluded.computed_total_tokens,
    request_count=request_count+excluded.request_count, model_error_count=model_error_count+excluded.model_error_count,
    ttft_sum_ms=ttft_sum_ms+excluded.ttft_sum_ms, ttft_count=ttft_count+excluded.ttft_count`).run(
    row.bucket_start,
    row.workspace_key,
    row.provider_id,
    row.model_id,
    row.query_source,
    sign * row.input_tokens,
    sign * row.output_tokens,
    sign * row.reasoning_tokens,
    sign * row.cache_creation_tokens,
    sign * row.cache_read_tokens,
    sign * row.computed_total_tokens,
    requestCount,
    sign * row.is_error,
    sign * (row.ttft_ms ?? 0),
    ttftCount,
    ...modelGroup(row),
  );
}

function applyToolDifference(db: DatabaseSync, old: ToolRawRow | null, current: ToolRawRow): void {
  const sameGroup = old !== null && TOOL_KEYS.every((key) => old[key] === current[key]);
  if (!sameGroup) {
    if (old) applyToolDelta(db, old, -1);
    if (isProtectedToolRow(db, current)) applyToolDelta(db, current, 1);
    return;
  }
  if (sameGroup) {
    const delta: ToolRawRow = {
      ...current,
      is_error: current.is_error - old!.is_error,
      duration_ms: (current.duration_ms ?? 0) - (old!.duration_ms ?? 0),
    };
    if (isProtectedToolRow(db, current)) {
      applyToolDelta(
        db,
        delta,
        1,
        0,
        Number(current.duration_ms !== null) - Number(old!.duration_ms !== null),
      );
    }
  }
}

function applyToolDelta(
  db: DatabaseSync,
  row: ToolRawRow,
  sign: number,
  callCount = sign,
  durationCount = sign * Number(row.duration_ms !== null),
): void {
  db.prepare(`insert into fork_usage_protected_tool (
    bucket_start, workspace_key, tool_name, call_count, error_count, duration_sum_ms, duration_count
  ) select ?, ?, ?, ?, ?, ?, ? where exists (
    select 1 from fork_usage_protected_bucket p where p.kind='tool' and p.bucket_start=?
      and p.workspace_key=? and p.tool_name=?
  ) on conflict(bucket_start, workspace_key, tool_name) do update set
    call_count=call_count+excluded.call_count, error_count=error_count+excluded.error_count,
    duration_sum_ms=duration_sum_ms+excluded.duration_sum_ms,
    duration_count=duration_count+excluded.duration_count`).run(
    row.bucket_start,
    row.workspace_key,
    row.tool_name,
    callCount,
    sign * row.is_error,
    sign * (row.duration_ms ?? 0),
    durationCount,
    ...toolGroup(row),
  );
}

function isProtectedModelRow(db: DatabaseSync, row: ModelRawRow): boolean {
  return Boolean(
    db
      .prepare(`select 1 from fork_usage_protected_bucket where kind='model'
    and bucket_start=? and workspace_key=? and provider_id=? and model_id=? and query_source=?`)
      .get(...modelGroup(row)),
  );
}

function isProtectedToolRow(db: DatabaseSync, row: ToolRawRow): boolean {
  return Boolean(
    db
      .prepare(`select 1 from fork_usage_protected_bucket where kind='tool'
    and bucket_start=? and workspace_key=? and tool_name=?`)
      .get(...toolGroup(row)),
  );
}

function modelGroup(row: ModelRawRow): SQLInputValue[] {
  return [row.bucket_start, row.workspace_key, row.provider_id, row.model_id, row.query_source];
}

function toolGroup(row: ToolRawRow): SQLInputValue[] {
  return [row.bucket_start, row.workspace_key, row.tool_name];
}

function modelValues(row: ModelRawRow): SQLInputValue[] {
  return [
    row.id,
    ...modelGroup(row),
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_creation_tokens,
    row.cache_read_tokens,
    row.computed_total_tokens,
    row.is_error,
    row.ttft_ms,
  ];
}

function toolValues(row: ToolRawRow): SQLInputValue[] {
  return [row.id, ...toolGroup(row), row.is_error, row.duration_ms];
}
