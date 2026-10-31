import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- The task index repository keeps SQLite schema, queries, and state writes together; split by read/write responsibility after migrations stabilize. */
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  normalizeAgentProviderToZCodeAgent,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeExecutionWorktree,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";
import type {
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getZCodeDataRootDir } from "#src/paths.js";
import {
  createProjectDataRepository,
  projectStorage,
  type ProjectMigrationContext,
} from "#src/project-storage/index.js";
import { RESERVATION_PLACEHOLDER_SQL } from "#src/project-storage/project-repository.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // Filter lists by the current runtime provider; historical import source does not change this boundary.
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** One task row's meta_json convergence: see TaskIndexRepo.convergeTaskMetas. */
type TaskMetaConvergence = {
  taskId: string;
  converged: (meta: Record<string, unknown>) => boolean;
  patch: (meta: Record<string, unknown>) => Record<string, unknown>;
};
type SQLInputValue = import("node:sqlite").SQLInputValue;

interface TaskIndexRow {
  // Upstream CLI-fact columns from the project-storage migration (0005_projects); absent only before that migration.
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: string | null;
  cli_deleted?: number | null;
  handoff_pending?: number | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

/**
 * List reads never need the (up to 200 KB per row) body text, and tasks-index.sqlite is read
 * synchronously in the Host, so they select the row without searchable_text.
 */
type TaskIndexMetaRow = Omit<TaskIndexRow, "searchable_text">;

interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

interface TaskGroupRow {
  group_id: string;
  title: string;
  color: string;
  created_at: number;
  updated_at: number;
}

interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupWorkspaceBootstrapRow {
  workspace_key: string;
  group_id: string | null;
}

interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // Only the dedicated unread write path may modify an existing row; other metadata/snapshot writes must preserve the current CAS marker.
  writeUnreadAt?: boolean;
  // searchableText is optional: undefined means retain the existing value for an existing row.
  // Writes such as applyAgentPatch / updateTaskState without message context therefore do not clear already indexed content.
  searchableText?: string;
  // CLI activity time carried by this write (CLI snapshot, legacy import, or terminal summary). undefined leaves
  // cli_updated_at unchanged. Organization writes must not pass it: a Host-side time in the CLI column reorders the list.
  cliUpdatedAt?: number;
}

export interface TaskIndexWorktreeOwnerFact {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  deleted: boolean;
  executionWorktree?: ZCodeTaskMeta["executionWorktree"];
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
}

// Key business rule: chat search needs only matchable text, not an unlimited full copy of a long session in the SQLite index.
// Truncate at the limit so long tasks do not grow tasks-index.sqlite enough to affect startup or list queries.
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const GROUPED_TASK_ORDER_STEP = 1000;
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY = "__zcode_internal_grouped_workspace_bootstrap_once__";
const DEFAULT_TASK_GROUP_COLOR: ZCodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];

const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function shouldPreserveNewerTerminalStatus(
  existingMeta: ZCodeTaskMeta | null,
  incomingMeta: ZCodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexMetaRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key is the actual basis for SQLite queries and primary-key isolation. If it is a normalized remote identity,
  // the returned value must match it; a stale workspace_identity column must not project the entity into another remote workspace.
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // Do not use an identity projection that disagrees with the primary key, and do not fall back to workspacePath for a remote entity;
  // different remote workspaces at the same path would then collide in the sidebar activity join.
  return undefined;
}

// A row admitted through CLI facts (applyCliFacts) has cli_created_at populated. For such rows the CLI fact columns are the
// read authority for title, created/updated time and outcome, so a stale meta_json or legacy column cannot override them.
// Rows without facts keep the legacy projection, which is the only path the fork's syncTaskMeta writer produces.
const CLI_FACT_UPDATED_AT_SQL =
  "(CASE WHEN cli_created_at IS NULL THEN updated_at ELSE cli_updated_at END)";
const CLI_FACT_CREATED_AT_SQL =
  "(CASE WHEN cli_created_at IS NULL THEN created_at ELSE cli_created_at END)";
const CLI_FACT_TITLE_SQL =
  "(CASE WHEN cli_created_at IS NULL OR title_overridden = 1 THEN title ELSE cli_title END)";

// Reservation placeholder (signature defined with its only writer in project-repository.ts): every read hides it until applyCliFacts
// writes facts, so an abandoned create never shows up as an empty, zero-time task.
function isReservationPlaceholderRow(
  row: Pick<TaskIndexRow, "created_at" | "cli_created_at" | "meta_json">,
): boolean {
  return row.cli_created_at == null && row.created_at === 0 && row.meta_json === "{}";
}

function projectCliFacts(row: TaskIndexMetaRow, meta: ZCodeTaskMeta): ZCodeTaskMeta {
  if (row.cli_created_at == null) return meta;
  const outcome =
    row.cli_last_outcome === "interrupted" ? "completed" : (row.cli_last_outcome ?? undefined);
  return {
    ...meta,
    title: row.title_overridden === 1 ? row.title : (row.cli_title ?? meta.title),
    createdAt: row.cli_created_at,
    updatedAt: row.cli_updated_at ?? meta.updatedAt,
    status: (outcome ?? row.task_status ?? meta.status) as ZCodeTaskMeta["status"],
  };
}

function rowToMeta(row: TaskIndexMetaRow): ZCodeTaskMeta {
  return projectCliFacts(row, rowToStoredMeta(row));
}

function rowToStoredMeta(row: TaskIndexMetaRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite uses these fields to query and isolate entities; identity in old meta_json may be missing or refer to an old remote.
        // On read, match the row's primary-key projection so sessions-index can attach running activity by workspaceKey + taskId.
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread is product-shell state in tasks-index; scalar columns must override stale meta_json that may come from another Host.
        unreadAt: row.unread_at ?? undefined,
        // meta_json is authoritative for cron identity; cron_automation_id is an indexed projection used only as a fallback.
        // Historical meta_json may lack this field, so read the column as fallback; the next write backfills it into meta_json.
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // The fork link is immutable and is written by several writers; the column keeps it even when a snapshot write omits it from meta_json.
        forkedFromTaskId: row.forked_from_task_id ?? parsed.data.forkedFromTaskId,
        // Use the same strategy for off-peak identity: meta_json is authoritative, with the column as fallback, so migrating existing rows needs to write only the column.
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    // A reservation placeholder (created_at 0, no CLI facts, default meta_json '{}') is expected until CLI facts arrive; it is not corruption, so it stays silent.
    if (!isReservationPlaceholderRow(row)) {
      logger.warn(
        undefined,
        `读取 task index meta_json 非法 taskId=${row.task_id}`,
        parsed.error.flatten(),
      );
    }
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: row.title,
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    // A legacy row's provider column may contain a third-party CLI value; normalize it to glm when projecting the meta fallback.
    provider: row.provider
      ? normalizeAgentProviderToZCodeAgent(row.provider as ZCodeTaskMeta["provider"])
      : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
    status: (row.task_status as ZCodeTaskMeta["status"]) ?? undefined,
  };
}

/** Serialize meta to meta_json. Store cron identity with meta as the single source of truth, and project it to the cron_automation_id index column in writeRecord. */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaceBootstrapScopes(
  scopes: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }>,
): WorkspaceBootstrapScope[] {
  const seen = new Set<string>();
  const result: WorkspaceBootstrapScope[] = [];
  for (const scope of scopes) {
    if (scope.workspacePurpose === "conversation") {
      // A conversation's backing workspace is only its cwd, not a project; do not create a same-named project group during migration.
      continue;
    }
    const key = workspaceKey(scope);
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      workspaceKey: key,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
    });
  }
  return result;
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// Global session search (TaskSearchDialog) returns snippets for summary display when the body matches.
// Center windows on matches, deduplicate nearby windows, and return at most four;
// if the title matches but no body text does, fall back to one full-body snippet to avoid an empty area.
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // Multiple nearby matches for the same term create heavily overlapping snippets; merge near-duplicates on the server first.
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // If the title matches but the body does not, still return one full-body snippet to avoid a blank area below the title.
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(
  row: TaskIndexMetaRow & { searchable_text?: string },
  search: string | null,
): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  // Non-search list reads do not select searchable_text; snippets are only built when searching.
  const snippets = buildSearchSnippets(row.searchable_text ?? "", search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function migrateLegacyTaskMetaJson(
  rawMetaJson: string,
  fallback: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: string;
    provider?: string;
    model?: string;
    status?: ZCodeTaskMeta["status"];
  },
): ZCodeTaskMeta {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(rawMetaJson) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const meta = {
    ...parsed,
    taskId: fallback.taskId,
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId
        ? parsed.traceId
        : `zcode-${fallback.taskId}`,
    title: fallback.title,
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : fallback.createdAt,
    updatedAt: fallback.updatedAt,
    mode: typeof parsed.mode === "string" ? parsed.mode : fallback.mode,
    provider: typeof parsed.provider === "string" ? parsed.provider : fallback.provider,
    model: typeof parsed.model === "string" ? parsed.model : fallback.model,
    status: typeof parsed.status === "string" ? parsed.status : fallback.status,
    migrationSource: undefined,
  };
  return zcodeTaskMetaSchema.parse(meta) as ZCodeTaskMeta;
}

function isTaskGroupColor(value: string): value is ZCodeTaskGroupColor {
  return (
    value === "gray" ||
    value === "red" ||
    value === "orange" ||
    value === "yellow" ||
    value === "green" ||
    value === "blue" ||
    value === "purple"
  );
}

function rowToTaskGroup(row: TaskGroupRow): ZCodeTaskGroup {
  return {
    id: row.group_id,
    title: row.title,
    color: isTaskGroupColor(row.color) ? row.color : DEFAULT_TASK_GROUP_COLOR,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

function workspaceGroupColor(targetWorkspaceKey: string): ZCodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}

function taskNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKey(params)}\u0000${params.taskId}`;
}

function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // Do not delimit task_group_view_node_orders.node_key with "\u0000";
  // node:sqlite truncates TEXT when reading after NUL, so grouped-view ordering would no longer match the taskId after being written.
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

function groupedTopNodeOrderRef(node: ZCodeGroupedTaskViewNode): {
  nodeType: "group" | "task";
  nodeKey: string;
  mapKey: string;
} {
  if (node.type === "group") {
    return {
      nodeType: "group",
      nodeKey: node.group.id,
      mapKey: `group:${node.group.id}`,
    };
  }
  const nodeKey = taskOrderNodeKey(node.task);
  return {
    nodeType: "task",
    nodeKey,
    mapKey: `task:${nodeKey}`,
  };
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return groupedTopNodeOrderRef(left).mapKey.localeCompare(groupedTopNodeOrderRef(right).mapKey);
}

function compareCronGroupTasks(left: ZCodeTaskListItem, right: ZCodeTaskListItem): number {
  // The cron system group is always ordered by creation time descending so the latest scheduled-task result appears first.
  // It does not use the user's manual sort_order; a new session naturally appears at the top of the group.
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return taskNodeKey(right).localeCompare(taskNodeKey(left));
}

function compareGroupTasks(
  left: ZCodeTaskListItem,
  right: ZCodeTaskListItem,
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): number {
  const leftMember = memberByTaskKey.get(taskNodeKey(left));
  const rightMember = memberByTaskKey.get(taskNodeKey(right));
  const leftOrder = leftMember?.sort_order ?? 0;
  const rightOrder = rightMember?.sort_order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return taskNodeKey(left).localeCompare(taskNodeKey(right));
}

export class TaskIndexRepo {
  /** Startup migration result for the Host startup barrier; not a task fact or organization state. */
  migrationBackupSkipped = false;

  // Opt-in settings seed: a settings object as the first argument (no path) lets the one-time project migration
  // read the legacy lastWorkspaceSession. The ledger marker makes that import run once per database; the default
  // Host path passes a path or nothing, so production never seeds projects from settings.
  private readonly startupDbPath?: string;
  private readonly migrationSettings?: ProjectMigrationContext["settings"];

  constructor(
    startupDbPathOrSettings?: string | ProjectMigrationContext["settings"],
    private readonly startupBusyTimeoutMs = 5000,
    // Trusted owner Host of project rows (the Source Server storage identity on a standalone server); undefined means local.
    private readonly storageHostId?: string,
  ) {
    if (typeof startupDbPathOrSettings === "string") {
      this.startupDbPath = startupDbPathOrSettings;
    } else {
      this.migrationSettings = startupDbPathOrSettings;
    }
  }
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  /** Shared organization database handle for the project and remote-project services (not for UI or Repo callers). */
  async getOrganizationDatabase(): Promise<DatabaseSyncInstance> {
    await this.ensureReady();
    return this.getDatabase();
  }

  /** Project storage over the same tasks-index database; UI must reach it through project services. */
  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  async getProjectDataRepository() {
    await this.ensureReady();
    return createProjectDataRepository(this.getDatabase(), this.storageHostId);
  }

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // Release the failed connection; migration repair may have partially committed, and retry still uses the original idempotent initialization.
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // Multiple-window Hosts share tasks-index; write transactions and initial schema upgrades should wait briefly instead of immediately returning SQLITE_BUSY.
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // The Worker already performed the initial preparation for this path; the business connection must not repeat the full-table repair.
    // The startup Worker prepares only the tasks ledger; project-storage migrations are ledger-guarded and idempotent, so they always run here.
    if (isTasksStoragePrepared(path, this.db)) {
      await this.runProjectStorageMigrations();
      return;
    }
    if (!isTasksStorageMigrated(path, this.db)) await runTasksDatabaseMigrations(this.db);
    await this.runProjectStorageMigrations();
    this.backfillOffPeakTaskMarkers();
    this.backfillOffPeakGroupMemberships();
    // Bugfix: early z-code-2 list task_id values were wrapper IDs; the actual ZCode session ID was in the old
    // acp_session_id column. Mapping IDs at runtime would require dual-ID fallbacks across read/send/subscribe,
    // so migrate index rows to the actual session ID during initialization and use the normal new-protocol path afterward.
    this.migrateLegacyAcpTaskIds();
    this.cleanupDeletedTaskGroupingReferences();
  }

  /**
   * Upstream additive project-storage migrations (ledger `schema_migration`, ids 0005_projects and
   * 0006_default_workspace_tasks). They add project tables and the upstream `tasks` CLI-fact columns.
   * Settings are passed only when the caller supplied them (see constructor); the default Host path seeds no projects.
   */
  private async runProjectStorageMigrations(): Promise<void> {
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getZCodeDataRootDir(), "backup")],
      warn: (message, details) =>
        createServiceLogger("project-migration").warn(undefined, message, details),
    });
    this.migrationBackupSkipped = this.migrationBackupSkipped || migration.backupSkipped;
    // Upstream seeds the owner Host row from settings; the fork passes no settings, so register the trusted owner directly.
    if (this.storageHostId)
      this.getDatabase()
        .prepare(
          "INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES(?,?,(SELECT count(*) FROM hosts))",
        )
        .run(this.storageHostId, this.storageHostId === "local" ? "local" : "server");
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return columns.some((item) => item.name === column);
  }

  /**
   * Backfill existing rows (idempotent, self-healing on each bootstrap): off-peak session rows created before tracking launched have no
   * offPeakTaskId. off_peak_tasks shares the tasks database (tasks-index.sqlite); join by session and fill only the projection column.
   * rowToMeta can use the column fallback immediately, and the next syncTaskMeta call backfills meta_json. Guard for fresh installs where OffPeakTaskRepo may not have created off_peak_tasks yet.
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  /**
   * Backfill membership (idempotent, self-healing on each bootstrap): historical backfill added only the off_peak_task_id
   * projection column, so syncTaskMeta's “first marker” hook will never run for these existing rows (they already have the marker).
   * Add their system-group membership during bootstrap. OR IGNORE preserves the user's manual organization and makes repeated runs have no side effects;
   * do not create an empty group when there are no marked rows, so users who never used off-peak tasks do not see one.
   */
  private backfillOffPeakGroupMemberships(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, workspace_path, workspace_identity, task_id FROM tasks
         WHERE off_peak_task_id IS NOT NULL AND deleted = 0`,
      )
      .all() as Array<{
      workspace_key: string;
      workspace_path: string;
      workspace_identity: string | null;
      task_id: string;
    }>;
    for (const row of rows) {
      // Off-peak tasks do not yet support remote workspaces, so do not group existing remote rows. Historical rows may lack workspace_identity;
      // determine remote status from the primary key workspace_key, or ensureSystemGroupMembership may recompute a local key from workspacePath
      // and write membership into a local workspace at the same path.
      if (isRemoteWorkspaceIdentity(row.workspace_key)) {
        continue;
      }
      this.ensureOffPeakGroupMembership({
        workspacePath: row.workspace_path,
        workspaceIdentity: row.workspace_identity ?? undefined,
        taskId: row.task_id,
      });
    }
  }

  private migrateLegacyAcpTaskIds(): void {
    if (!this.hasColumn("tasks", "acp_session_id")) {
      return;
    }

    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
      )
      .all() as unknown as LegacyAcpTaskIndexRow[];
    if (rows.length === 0) {
      return;
    }

    const findTarget = db.prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const updateRow = db.prepare(
      `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
    );
    const updateTarget = db.prepare(
      `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
    );
    const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

    db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = 0;
      for (const row of rows) {
        const nextTaskId = row.acp_session_id?.trim();
        if (!nextTaskId) {
          continue;
        }
        const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
        const merged = this.buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
        if (target) {
          updateTarget.run(merged);
          deleteOld.run(row.workspace_key, row.task_id);
        } else {
          updateRow.run({ ...merged, old_task_id: row.task_id });
        }
        this.migrateLegacyAcpTaskGroupingReferences(row.workspace_key, row.task_id, nextTaskId);
        migrated += 1;
      }
      db.exec("COMMIT");
      if (migrated > 0) {
        logger.info(undefined, `已迁移 legacy ACP task_id 到 ZCode session id 数量=${migrated}`);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateLegacyAcpTaskGroupingReferences(
    workspaceKeyValue: string,
    oldTaskId: string,
    taskId: string,
  ): void {
    const db = this.getDatabase();
    const now = Date.now();
    const oldTaskNodeKey = `${workspaceKeyValue}\u0000${oldTaskId}`;
    const nextTaskNodeKey = `${workspaceKeyValue}\u0000${taskId}`;

    // Bugfix: task_group_members and task_group_view_node_orders both use task_id as their reference key.
    // Migrating only the tasks table would leave old ACP group relations pointing to wrapper IDs, so group views could not find the actual session.
    const targetMember = db
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKeyValue, taskId) as { found: number } | undefined;
    if (targetMember) {
      db.prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      ).run(workspaceKeyValue, oldTaskId);
    } else {
      db.prepare(
        `UPDATE task_group_members
        SET task_id = ?, updated_at = ?
        WHERE workspace_key = ? AND task_id = ?`,
      ).run(taskId, now, workspaceKeyValue, oldTaskId);
    }

    const targetOrder = db
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nextTaskNodeKey) as { found: number } | undefined;
    if (targetOrder) {
      db.prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?`,
      ).run(oldTaskNodeKey);
      return;
    }
    db.prepare(
      `UPDATE task_group_view_node_orders
      SET node_key = ?, updated_at = ?
      WHERE node_type = 'task' AND node_key = ?`,
    ).run(nextTaskNodeKey, now, oldTaskNodeKey);
  }

  private deleteTaskGroupingReferencesReady(workspaceKeyValue: string, taskId: string): void {
    const database = this.getDatabase();
    database
      .prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(workspaceKeyValue, taskId);
    database
      .prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      )
      .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
  }

  private cleanupDeletedTaskGroupingReferences(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, task_id
        FROM tasks
        WHERE deleted = 1`,
      )
      .all() as Array<{ workspace_key: string; task_id: string }>;
    if (rows.length === 0) {
      return;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      // Older versions set only tasks.deleted when deleting a task, leaving membership/top-level order to be reprojected from
      // historical sessions-index summaries. Idempotently converge already persisted stale references during initialization.
      for (const row of rows) {
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private buildLegacyAcpMigratedRow(
    source: LegacyAcpTaskIndexRow,
    target: TaskIndexRow | null,
    taskId: string,
  ): Record<string, SQLInputValue> {
    const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
      taskId,
      workspacePath: source.workspace_path,
      workspaceIdentity: source.workspace_identity ?? undefined,
      title: source.title,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      mode: source.mode,
      provider: source.provider ?? undefined,
      model: source.model ?? undefined,
      status: source.task_status ? (source.task_status as ZCodeTaskMeta["status"]) : undefined,
    });
    if (!target) {
      return {
        workspace_key: source.workspace_key,
        task_id: taskId,
        title: source.title,
        task_status: source.task_status,
        provider: source.provider,
        mode: source.mode,
        model: source.model,
        migration_source: null,
        forked_from_task_id: source.forked_from_task_id,
        created_at: source.created_at,
        updated_at: source.updated_at,
        unread_at: source.unread_at,
        last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
        pinned: source.pinned,
        archived: source.archived,
        deleted: source.deleted,
        title_overridden: source.title_overridden,
        searchable_text: source.searchable_text,
        meta_json: JSON.stringify(sourceMeta),
      };
    }

    const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
      ...sourceMeta,
      taskId,
      workspacePath: target.workspace_path,
      workspaceIdentity: target.workspace_identity ?? undefined,
      title: target.title || source.title,
      createdAt: Math.min(target.created_at, source.created_at),
      updatedAt: Math.max(target.updated_at, source.updated_at),
      mode: target.mode || source.mode,
      provider: target.provider ?? source.provider ?? undefined,
      model: target.model ?? source.model ?? undefined,
      status: target.task_status
        ? (target.task_status as ZCodeTaskMeta["status"])
        : source.task_status
          ? (source.task_status as ZCodeTaskMeta["status"])
          : undefined,
    });
    const title = source.title_overridden === 1 ? source.title : target.title || source.title;
    const updatedAt = Math.max(target.updated_at, source.updated_at);
    const unreadAt =
      source.unread_at !== null && target.unread_at !== null
        ? Math.max(source.unread_at, target.unread_at)
        : (source.unread_at ?? target.unread_at);
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title,
      task_status: target.task_status ?? source.task_status,
      provider: target.provider ?? source.provider,
      mode: target.mode || source.mode,
      model: target.model ?? source.model,
      migration_source: null,
      forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
      created_at: Math.min(target.created_at, source.created_at),
      updated_at: updatedAt,
      unread_at: unreadAt,
      last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
      pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
      archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
      deleted: source.deleted === 1 ? 1 : target.deleted,
      title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
      searchable_text: target.searchable_text || source.searchable_text,
      meta_json: JSON.stringify({
        ...targetMeta,
        title,
        updatedAt,
        unreadAt: unreadAt ?? undefined,
        migrationSource: undefined,
      }),
    };
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private getNextGroupedTopSortOrder(): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT MIN(sort_order) AS min_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { min_sort_order: number | null } | undefined;
    return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
  }

  private upsertGroupedTopOrder(params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  }): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, node_key) DO UPDATE SET
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      )
      .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
  }

  private normalizeGroupedTopNodeOrders(
    nodes: ZCodeGroupedTaskViewNode[],
    orderByNodeKey: Map<string, TaskGroupViewNodeOrderRow>,
  ): void {
    const missingNodes = nodes
      .filter((node) => !orderByNodeKey.has(groupedTopNodeOrderRef(node).mapKey))
      .sort((left, right) => {
        const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
        const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
        if (rightCreated !== leftCreated) {
          return rightCreated - leftCreated;
        }
        return groupedTopNodeOrderRef(left).mapKey.localeCompare(
          groupedTopNodeOrderRef(right).mapKey,
        );
      });
    if (missingNodes.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const insertOrder = this.getDatabase().prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const node of missingNodes) {
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        const ref = groupedTopNodeOrderRef(node);
        insertOrder.run(ref.nodeType, ref.nodeKey, nextSortOrder, now, now);
        const rowValue: TaskGroupViewNodeOrderRow = {
          node_type: ref.nodeType,
          node_key: ref.nodeKey,
          sort_order: nextSortOrder,
          created_at: now,
          updated_at: now,
        };
        orderByNodeKey.set(ref.mapKey, rowValue);
        node.sortOrder = nextSortOrder;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  private normalizeGroupMemberOrders(
    groupId: string,
    tasks: ZCodeTaskListItem[],
    memberByTaskKey: Map<string, TaskGroupMemberRow>,
  ): void {
    const missingTasks = tasks
      .filter((task) => {
        const member = memberByTaskKey.get(taskNodeKey(task));
        return Boolean(member) && member?.sort_order === null;
      })
      .sort((left, right) => {
        const leftMember = memberByTaskKey.get(taskNodeKey(left));
        const rightMember = memberByTaskKey.get(taskNodeKey(right));
        const leftAdded = leftMember?.added_at ?? left.createdAt;
        const rightAdded = rightMember?.added_at ?? right.createdAt;
        if (rightAdded !== leftAdded) {
          return rightAdded - leftAdded;
        }
        return taskNodeKey(left).localeCompare(taskNodeKey(right));
      });
    if (missingTasks.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_members
        WHERE group_id = ?`,
      )
      .get(groupId) as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const updateMemberOrder = this.getDatabase().prepare(
      `UPDATE task_group_members
      SET sort_order = ?, updated_at = ?
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const task of missingTasks) {
        const memberKey = taskNodeKey(task);
        const member = memberByTaskKey.get(memberKey);
        if (!member) {
          continue;
        }
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        updateMemberOrder.run(nextSortOrder, now, member.workspace_key, member.task_id);
        member.sort_order = nextSortOrder;
        member.updated_at = now;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return this.hasGroupedWorkspaceBootstrapRunSync();
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }

    const archiveTask = this.getDatabase().prepare(
      `UPDATE tasks
      SET archived = 1
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        archiveTask.run(row.workspace_key, row.task_id);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return rows.map(rowToMeta);
  }

  private hasGroupedWorkspaceBootstrapRunSync(): boolean {
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS found
        FROM task_group_workspace_bootstraps
        LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  private bootstrapWorkspaceGroupsForActiveTasks(params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: TaskIndexRow[];
  }): void {
    if (params.scopes.length === 0 || this.hasGroupedWorkspaceBootstrapRunSync()) {
      return;
    }
    const database = this.getDatabase();
    const candidateRowsByWorkspaceKey = new Map<string, TaskIndexRow[]>();
    for (const row of params.activeTasks) {
      const rows = candidateRowsByWorkspaceKey.get(row.workspace_key) ?? [];
      rows.push(row);
      candidateRowsByWorkspaceKey.set(row.workspace_key, rows);
    }
    const now = Date.now();
    const markBootstrapRun = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    if (candidateRowsByWorkspaceKey.size === 0) {
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      return;
    }
    const existingGroupOrderKeys = new Set(
      (
        database
          .prepare(
            `SELECT node_key
            FROM task_group_view_node_orders
            WHERE node_type = 'group'`,
          )
          .all() as Array<{ node_key: string }>
      ).map((row) => row.node_key),
    );
    const maxOrderRow = database
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
    const insertGroup = database.prepare(
      `INSERT OR IGNORE INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertGroupOrder = database.prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES ('group', ?, ?, ?, ?)`,
    );
    const deleteExistingMember = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const insertMember = database.prepare(
      `INSERT INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        group_id = excluded.group_id,
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    );
    const deleteTopTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?`,
    );
    const insertBootstrap = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        group_id = excluded.group_id,
        updated_at = excluded.updated_at`,
    );
    const deleteEmptyGroups = database.prepare(
      `DELETE FROM task_groups
      WHERE group_id NOT IN (
        SELECT DISTINCT group_id
        FROM task_group_members
      )`,
    );
    const deleteDanglingGroupOrders = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'group'
        AND node_key NOT IN (
          SELECT group_id
          FROM task_groups
        )`,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      // Grouped workspace bootstrap is a one-time migration initialization. Record a global marker
      // to prevent automatically creating workspace groups again when later workspaces appear.
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      for (const scope of params.scopes) {
        const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
        if (!rows) {
          continue;
        }
        // Rebuild membership from the workspace view that existed before grouping was available.
        // Ignore old groups when determining ownership so historical groups do not leave tasks in non-workspace groups.
        const groupedRows = rows.sort((left, right) => {
          if (right.updated_at !== left.updated_at) {
            return right.updated_at - left.updated_at;
          }
          if (right.created_at !== left.created_at) {
            return right.created_at - left.created_at;
          }
          return left.task_id.localeCompare(right.task_id);
        });
        if (groupedRows.length === 0) {
          continue;
        }
        const groupId = workspaceGroupId(scope.workspaceKey);
        const title = workspaceGroupTitle(scope.workspacePath);
        insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
        if (!existingGroupOrderKeys.has(groupId)) {
          nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
          insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
          existingGroupOrderKeys.add(groupId);
        }
        groupedRows.forEach((row, index) => {
          deleteExistingMember.run(row.workspace_key, row.task_id);
          insertMember.run(
            groupId,
            row.workspace_key,
            row.workspace_path,
            row.workspace_identity,
            row.task_id,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
          deleteTopTaskOrder.run(
            taskOrderNodeKey({
              workspacePath: row.workspace_path,
              workspaceIdentity: row.workspace_identity ?? undefined,
              taskId: row.task_id,
            }),
          );
        });
        insertBootstrap.run(scope.workspaceKey, groupId, now, now);
      }
      deleteEmptyGroups.run();
      deleteDanglingGroupOrders.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRecord(input: TaskIndexWriteRecord): ZCodeTaskMeta {
    // A tombstoned row is never listed or searched, so it must not accumulate conversation text: a late
    // syncer write after a permanent erase (specs/session-deletion-cascade.md §4) would otherwise bring
    // the erased title and body back into this index.
    const record: TaskIndexWriteRecord = input.deleted
      ? { ...input, meta: { ...input.meta, title: "" }, searchableText: "" }
      : input;
    // searchable_text = undefined means “leave the current value unchanged.” Read the existing row once;
    // otherwise ON CONFLICT could set excluded.searchable_text to an empty string and clear indexed body text.
    const existing =
      record.searchableText === undefined
        ? this.getTaskRow({
            workspacePath: record.meta.workspacePath,
            workspaceIdentity: record.meta.workspaceIdentity,
            taskId: record.meta.taskId,
          })
        : null;
    const searchableText =
      record.searchableText !== undefined
        ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
        : (existing?.searchable_text ?? "");
    this.getDatabase()
      .prepare(
        `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          -- The first stored fork link wins: a later write with another parent must not re-parent the fork.
          forked_from_task_id = COALESCE(tasks.forked_from_task_id, excluded.forked_from_task_id),
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE
            WHEN @write_unread_at = 1 THEN excluded.unread_at
            ELSE tasks.unread_at
          END,
          last_unread_at = MAX(
            tasks.last_unread_at,
            COALESCE(tasks.unread_at, 0),
            CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
          ),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json,
          -- Mirror the organization write into the CLI fact columns of CLI-admitted rows. The project migration backfills
          -- cli_* from the legacy columns once; without this mirror a later fork write would leave the read projection stale.
          -- cli_updated_at is the exception: it moves only with an explicit CLI activity time (cliUpdatedAt), never with updated_at.
          cli_title = CASE WHEN tasks.cli_created_at IS NULL OR excluded.title_overridden = 1
            THEN tasks.cli_title ELSE excluded.title END,
          cli_created_at = CASE WHEN tasks.cli_created_at IS NULL THEN NULL ELSE excluded.created_at END,
          cli_updated_at = CASE WHEN tasks.cli_created_at IS NULL THEN NULL
            WHEN @cli_updated_at IS NULL THEN tasks.cli_updated_at
            ELSE MAX(COALESCE(tasks.cli_updated_at, 0), @cli_updated_at) END,
          cli_last_outcome = CASE WHEN tasks.cli_created_at IS NULL THEN tasks.cli_last_outcome
            WHEN excluded.task_status IN ('completed', 'error') THEN excluded.task_status ELSE NULL END`,
      )
      .run({
        workspace_key: workspaceKey(record.meta),
        workspace_path: record.meta.workspacePath,
        workspace_identity: record.meta.workspaceIdentity ?? null,
        task_id: record.meta.taskId,
        title: record.meta.title,
        task_status: record.meta.status ?? null,
        provider: record.meta.provider ?? null,
        mode: record.meta.mode,
        model: record.meta.model ?? null,
        migration_source: record.meta.migrationSource ?? null,
        forked_from_task_id: record.meta.forkedFromTaskId ?? null,
        // Project cron automation identity from meta to the index column (also retained in meta_json; see serializeMetaJson).
        cron_automation_id: record.meta.cronAutomationId ?? null,
        // Project off-peak identity the same way.
        off_peak_task_id: record.meta.offPeakTaskId ?? null,
        created_at: record.meta.createdAt,
        updated_at: record.meta.updatedAt,
        unread_at: record.meta.unreadAt ?? null,
        last_unread_at: record.meta.unreadAt ?? 0,
        write_unread_at: record.writeUnreadAt ? 1 : 0,
        pinned: record.pinned ? 1 : 0,
        archived: record.archived ? 1 : 0,
        deleted: record.deleted ? 1 : 0,
        title_overridden: record.titleOverridden ? 1 : 0,
        searchable_text: searchableText,
        cli_updated_at: record.cliUpdatedAt ?? null,
        meta_json: serializeMetaJson(record.meta),
      });
    const persisted = this.getTaskRow(record.meta);
    if (!persisted) {
      throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
    }
    return rowToMeta(persisted);
  }

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    // The caller may calculate body text from snapshot.messages and pass it in to refresh searchable_text.
    // If omitted, retain the searchable_text already in SQLite (fallback in writeRecord).
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** Atomically commit the task row and grouped top-level order when first exposing a root task. */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: {
      meta: ZCodeTaskMeta;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      titleOverridden?: boolean;
      searchableText?: string;
    },
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const database = this.getDatabase();
      if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        const existingMeta = existing ? rowToMeta(existing) : null;
        const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
        // snapshot.updatedAt is the “last structural change” time from the runtime sessionStore and may not include the Date.now() updates
        // triggered by events such as session.titleUpdated / turn.completed. Overwriting directly with params.meta.updatedAt could roll back the timestamp
        // just written by applyAgentPatch and push a new session back to the bottom after its first prompt. Use the maximum of this and the SQLite value so time never moves backward.
        const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
        const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
          existingMeta,
          params.meta,
        );
        const meta: ZCodeTaskMeta = {
          ...params.meta,
          // The Agent owns the session's core title; a user rename is app-side task state.
          // Preserve an overridden title while syncing Agent snapshots so background refreshes do not overwrite the user's title.
          title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
          titleOverridden,
          // turn.completed first writes a newer completed/error state through applyAgentPatch.
          // A protocol snapshot arriving afterward may still say running; downgrading status here would restore a completed task as “working” when mobile replayable returns to it.
          status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
          lastError: preserveExistingTerminalStatus
            ? existingMeta?.lastError
            : params.meta.lastError,
          target: Object.prototype.hasOwnProperty.call(params.meta, "target")
            ? params.meta.target
            : existingMeta?.target,
          // After a Claude Code import is upgraded to a real ZCode session, the protocol snapshot itself does not know the migration source.
          // Preserve the existing migrationSource when syncing runtime snapshots so list filtering and later model changes do not treat the imported task as a regular ZCode task.
          migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
          // Preserve existing cron automation identity when syncing runtime snapshots: runtime protocol snapshot meta has no cron marker.
          // Without the stored value as a fallback, a later sync would erase cron identity and break its icon/group/association queries.
          cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
          // Apply the same fallback for off-peak identity: preserve existing ownership when the snapshot has no marker.
          offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
          // Runtime session snapshots do not carry the worktree fact (BUG-GWT-010); preserve the fact converged
          // from sessions-index so a later sync never erases it and the marker survives restarts of closed workspaces.
          executionWorktree: params.meta.executionWorktree ?? existingMeta?.executionWorktree,
          // Runtime snapshots carry no incognito marker; keep the converged `true` so a sync never erases it
          // (specs/incognito-session.md "Sidebar marker durability").
          incognito: params.meta.incognito ?? existingMeta?.incognito,
          updatedAt,
          unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
        };
        const persistedMeta = this.writeRecord({
          meta,
          pinned: params.pinned ?? existing?.pinned === 1,
          archived: params.archived ?? existing?.archived === 1,
          deleted: params.deleted ?? existing?.deleted === 1,
          titleOverridden,
          searchableText: params.searchableText,
          // syncTaskMeta metas come from CLI snapshots and legacy imports, so their updatedAt is CLI activity time.
          cliUpdatedAt: updatedAt,
        });
        // Add a cron session to the fixed cron group when it first receives cronAutomationId.
        // An in-session CronCreate adds the cron marker to an existing task, so checking only !existing would leave it out of the scheduled-task group.
        // INSERT OR IGNORE preserves existing membership, so a user who later moves it out of the cron group will not have it moved back automatically.
        if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
          this.ensureCronGroupMembership(meta);
        }
        // Add an off-peak session to the fixed off-peak system group when it first receives offPeakTaskId (same mechanism as cron).
        if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
          this.ensureOffPeakGroupMembership(meta);
        }
        // Root draft first input previously committed the task row and then wrote sort_order separately.
        // If sessions-index exposed the task between writes, Renderer appended the unordered node to the end.
        const initializedGroupedOrder = initializeGroupedAtTop
          ? this.initializeGroupedTaskAtTopReady(meta)
          : false;
        if (initializeGroupedAtTop) database.exec("COMMIT");
        return { meta: persistedMeta, initializedGroupedOrder };
      } catch (error) {
        if (initializeGroupedAtTop) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * Add a cron session to the fixed cron system group (see CRON_DEFAULT_GROUP_ID).
   * Idempotent: use INSERT OR IGNORE for the group row, view order, and membership so user organization is never overwritten.
   * Called once by syncTaskMeta when a session first receives cronAutomationId.
   */
  private ensureCronGroupMembership(meta: ZCodeTaskMeta): void {
    this.ensureSystemGroupMembership(meta, {
      groupId: CRON_DEFAULT_GROUP_ID,
      title: "cron",
      color: "blue",
    });
  }

  /**
   * Add an off-peak session to the fixed off-peak system group (see OFF_PEAK_DEFAULT_GROUP_ID).
   * Uses the same mechanism as cron; called by syncTaskMeta when offPeakTaskId is first received,
   * or by bootstrap to backfill existing rows.
   */
  private ensureOffPeakGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): void {
    // Off-peak tasks do not yet support remote workspaces; do not add remote sessions to the off-peak system group even if they have a marker.
    if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
      return;
    }
    this.ensureSystemGroupMembership(meta, {
      groupId: OFF_PEAK_DEFAULT_GROUP_ID,
      title: "off-peak",
      color: "purple",
    });
  }

  private ensureSystemGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
    params: { groupId: string; title: string; color: string },
  ): void {
    const database = this.getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(params.groupId, params.title, params.color, now, now);
    // Group view order: insert only if absent (OR IGNORE) so each new system-group session does not change the group's order.
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
        VALUES ('group', ?, ?, ?, ?)`,
      )
      .run(params.groupId, this.getNextGroupedTopSortOrder(), now, now);
    // OR IGNORE: preserve an existing membership if the user has already grouped this task manually.
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.groupId,
        workspaceKey(meta),
        meta.workspacePath,
        meta.workspaceIdentity ?? null,
        meta.taskId,
        now,
        now,
        now,
      );
  }

  /**
   * Write baseline metadata only when the index row does not exist; preserve product-shell state exactly for existing rows, including deleted ones.
   *
   * A V4 session path in a remote workspace may create its sessions-index subscription after the session itself.
   * The first snapshot must populate a new tasks-index.sqlite, but must not overwrite existing pin/archive/unread/manual-title state with summary defaults
   * or race with a later full snapshot write.
   */
  /**
   * Upstream CLI-fact writer (ported additively). Only the CLI syncer may call it: CLI facts are the sole source of
   * these values, and organization writers must not synthesize them. No fork runtime caller is wired yet.
   */
  async applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        // A reserved row has no CLI facts yet. The first fact fills provider and display baseline, and keeps organization changes made after reservation.
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        // Upstream admits the task into project storage on every row write; this CLI-fact path does the same, and the
        // fork's organization writer (syncTaskMeta) deliberately does not, so project membership is set only by CLI facts.
        projectStorage.admitTaskIdentity(db, params.meta, this.storageHostId);
        const source = params.titleSource ?? "default";
        // Title recency lives in meta_json (no column). Only a non-negative integer from CLI facts is written, and applyCliFacts is the sole writer of this key on admitted rows.
        const titleUpdatedAt = params.meta.titleUpdatedAt;
        const persistedTitleUpdatedAt =
          titleUpdatedAt !== undefined &&
          Number.isSafeInteger(titleUpdatedAt) &&
          titleUpdatedAt >= 0
            ? titleUpdatedAt
            : null;
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END,
          meta_json=CASE WHEN ? AND json_valid(meta_json) THEN json_set(meta_json,'$.titleUpdatedAt',?) ELSE meta_json END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          persistedTitleUpdatedAt === null ? 0 : 1,
          persistedTitleUpdatedAt,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        const persisted = this.getTaskRow(params.meta)!;
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * Admits a fork child from its sessions-index summary. The CLI emits the child summary before or after the forkAssistant ACK,
   * so the first summary claims the child for the parent's project whenever the parent is owned, and only then applies CLI facts.
   * The claim must come first: applyCliFacts' admitTaskIdentity would pick a project by cwd, and claimForkedTask would then skip
   * copying the parent's frozen directories. Each step is its own write, because reserveCreatedTask and applyCliFacts each open a
   * transaction and must not nest. Unowned parents are not claimed here; they keep the unowned admission that applyCliFacts already does.
   * Returns changed=true only when ownership, the fork link or a CLI fact column differs from its stored value, so a repeated
   * summary stays silent for the caller.
   */
  async admitForkSummary(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
  }): Promise<{ meta: ZCodeTaskMeta; changed: boolean }> {
    const parentTaskId = params.meta.forkedFromTaskId;
    if (!parentTaskId) throw new Error("task index 分叉准入缺少 forkedFromTaskId");
    await this.seedTaskMetaIfMissing(params.meta);
    const projects = await this.getProjectRepository();
    const child = {
      workspacePath: params.meta.workspacePath,
      workspaceIdentity: params.meta.workspaceIdentity,
      taskId: params.meta.taskId,
    };
    const parent = { ...child, taskId: parentTaskId };
    const before = await this.enqueueWrite(params.meta, () => {
      const snapshot = this.readForkAdmissionState(child);
      // A resync can create or rewrite the row before this runs, and the snapshot carries no parent id, so the link is filled once and never replaced.
      this.getDatabase()
        .prepare(
          "UPDATE tasks SET forked_from_task_id=COALESCE(forked_from_task_id,?) WHERE workspace_key=? AND task_id=?",
        )
        .run(parentTaskId, workspaceKey(child), child.taskId);
      if (
        this.readTaskHostId(child) === null &&
        this.readTaskHostId(parent) === (this.storageHostId ?? "local")
      ) {
        projects.reserveCreatedTask({ task: child, forkOf: parent });
      }
      return snapshot;
    });
    const meta = await this.applyCliFacts({ meta: params.meta, titleSource: params.titleSource });
    const after = this.readForkAdmissionState(child);
    return { meta, changed: JSON.stringify(before) !== JSON.stringify(after) };
  }

  /** Ownership, fork link and CLI fact columns; the fields admitForkSummary can change, excluding resync-owned organization fields. */
  private readForkAdmissionState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Record<string, unknown> | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT host_id, project_id, root_path, forked_from_task_id, cli_title, cli_title_source,
          cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted
        FROM tasks WHERE workspace_key=? AND task_id=?`,
      )
      .get(workspaceKey(params), params.taskId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  private readTaskHostId(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string | null {
    const row = this.getDatabase()
      .prepare("SELECT host_id FROM tasks WHERE workspace_key=? AND task_id=?")
      .get(workspaceKey(params), params.taskId) as { host_id: string | null } | undefined;
    return row?.host_id ?? null;
  }

  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => {
      const existing = this.getTaskRow(meta);
      if (existing) {
        return rowToMeta(existing);
      }
      return this.writeRecord({
        meta,
        pinned: false,
        archived: false,
        deleted: false,
        titleOverridden: meta.titleOverridden ?? false,
      });
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        if (current.unreadAt !== params.expectedUnreadAt) {
          database.exec("COMMIT");
          return { meta: current, cleared: false };
        }

        const nextMeta: ZCodeTaskMeta = {
          ...current,
          unreadAt: undefined,
        };
        // A mobile mark-read request may arrive after a new terminal unread state. Compare and write within the same
        // SQLite write transaction, or an old click can unconditionally clear a later unreadAt.
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          deleted: false,
          titleOverridden: row.title_overridden === 1,
          writeUnreadAt: true,
        });
        database.exec("COMMIT");
        return { meta: persistedMeta, cleared: true };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // Another client may restore the task while the confirmation dialog is open. Check archive state and write the tombstone in one transaction;
        // do not read and then delete. Skip already deleted/missing tasks so a retry after a CLI seed does not resurrect them.
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      const deleting = params.patch.deleted === true;
      const requestedUnreadAt = params.patch.unreadAt;
      const allocatingUnreadAt = typeof requestedUnreadAt === "number";
      const mutatingUnreadAt = "unreadAt" in params.patch;
      const transactional = deleting || mutatingUnreadAt;
      if (transactional) {
        database.exec("BEGIN IMMEDIATE");
      }
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        // Millisecond timestamps can assign the same version to two logical unreads for one task,
        // and after clearing unreadAt, using only the current value may reuse an old version. Allocate a strictly increasing marker
        // under the SQLite write lock using a persistent watermark that is not reset on clearing.
        const lastUnreadAt = Math.max(
          row.last_unread_at,
          row.unread_at ?? 0,
          current.unreadAt ?? 0,
        );
        const unreadAt = allocatingUnreadAt
          ? Math.max(requestedUnreadAt, lastUnreadAt + 1)
          : "unreadAt" in params.patch
            ? undefined
            : current.unreadAt;
        const nextMeta: ZCodeTaskMeta = {
          ...current,
          title: params.patch.title ?? current.title,
          titleOverridden: params.patch.titleOverridden ?? current.titleOverridden,
          model: params.patch.model ?? current.model,
          unreadAt,
          status: params.patch.status ?? current.status,
          lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
          target: "target" in params.patch ? params.patch.target : current.target,
        };
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: params.patch.pinned ?? row.pinned === 1,
          archived: params.patch.archived ?? row.archived === 1,
          deleted: params.patch.deleted ?? row.deleted === 1,
          titleOverridden: params.patch.titleOverridden ?? row.title_overridden === 1,
          writeUnreadAt: mutatingUnreadAt,
        });
        if (deleting) {
          // Commit the deletion marker and grouped references atomically; otherwise a failure in either write leaves
          // sessions-index content, task visibility, and SQLite group ownership inconsistent.
          this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        }
        if (transactional) database.exec("COMMIT");
        return persistedMeta;
      } catch (error) {
        if (transactional) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    // updatedAt is CLI activity time only (terminal summaries). Title echoes and organization writes omit it.
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target"> & {
      updatedAt?: number;
    };
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1) {
        return null;
      }
      const current = rowToMeta(row);
      const canAcceptAgentTitle = row.title_overridden !== 1;
      const nextMeta: ZCodeTaskMeta = {
        ...current,
        title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
        titleOverridden: row.title_overridden === 1,
        updatedAt: params.patch.updatedAt ?? current.updatedAt,
        status: params.patch.status ?? current.status,
        lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
        target: "target" in params.patch ? params.patch.target : current.target,
      };
      return this.writeRecord({
        meta: nextMeta,
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        deleted: row.deleted === 1,
        titleOverridden: row.title_overridden === 1,
        cliUpdatedAt: params.patch.updatedAt,
      });
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
    /**
     * Host sessions-index convergence input (BUG-GWT-010): execution-worktree facts learned from the live
     * sessions-index overlay are converged into meta_json before the read, so the fact survives restarts of
     * closed workspaces. Requires an explicit workspacePath scope; without it the read stays a plain read.
     */
    executionWorktreeFacts?: ReadonlyArray<{
      taskId: string;
      executionWorktree: ZCodeExecutionWorktree;
    }>;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    if (params.workspacePath && params.executionWorktreeFacts?.length) {
      await this.applyExecutionWorktreeFacts(
        {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        params.executionWorktreeFacts,
      );
    }
    // listTaskMetas supports querying all tasks when workspacePath is omitted, but workspaceKey requires a path.
    // Narrow the optional argument into an explicit workspace target first so types do not mix global and workspace queries.
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          cli_title,
          cli_created_at,
          cli_updated_at,
          cli_last_outcome,
          meta_json
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND (@include_deleted = 1 OR deleted = 0)
          AND NOT ${RESERVATION_PLACEHOLDER_SQL}
          -- Bugfix: the ZCode Agent list only accepts the current glm provider; Claude Code imports are also non-glm historical data.
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY ${CLI_FACT_UPDATED_AT_SQL} DESC, ${CLI_FACT_CREATED_AT_SQL} DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexMetaRow[];
    return rows.map(rowToMeta);
  }

  /**
   * Drop the conversation text kept in tombstoned rows (body index and title) after their sessions were
   * permanently erased. Identity columns and the deletion marker stay: they keep the session hidden.
   */
  async scrubDeletedTaskContent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
    clearExecutionWorktree?: boolean;
  }): Promise<void> {
    if (params.taskIds.length === 0) return;
    await this.ensureReady();
    const key = workspaceKey(params);
    for (const taskId of params.taskIds) {
      // Same per-task write chain as every other task write, so a pending syncer write lands first.
      await this.enqueueWrite({ ...params, taskId }, () => {
        this.getDatabase()
          .prepare(
            `UPDATE tasks
            SET searchable_text = '',
                title = '',
                meta_json = CASE
                  WHEN json_valid(meta_json) AND @clear_execution_worktree = 1
                    THEN json_remove(json_set(meta_json, '$.title', ''), '$.executionWorktree')
                  WHEN json_valid(meta_json) THEN json_set(meta_json, '$.title', '')
                  ELSE meta_json
                END
            WHERE workspace_key = @workspace_key AND task_id = @task_id AND deleted = 1`,
          )
          .run({
            workspace_key: key,
            task_id: taskId,
            clear_execution_worktree: params.clearExecutionWorktree ? 1 : 0,
          });
      });
    }
  }

  /** Tombstones of local workspaces (no remote identity), for permanent-erase maintenance. */
  async listLocalDeletedTaskRefs(params: {
    provider?: ZCodeProvider;
  }): Promise<Array<{ workspacePath: string; taskId: string }>> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT workspace_path, task_id
        FROM tasks
        WHERE deleted = 1
          AND (workspace_identity IS NULL OR TRIM(workspace_identity) = '')
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY workspace_path, task_id`,
      )
      .all({ provider: params.provider ?? null }) as Array<{
      workspace_path: string;
      task_id: string;
    }>;
    return rows.map((row) => ({ workspacePath: row.workspace_path, taskId: row.task_id }));
  }

  /** All local task-index owners and durable execution-worktree facts, including deletion state. */
  async listLocalWorktreeOwnerFacts(params: {
    provider?: ZCodeProvider;
  }): Promise<TaskIndexWorktreeOwnerFact[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          meta_json
        FROM tasks
        WHERE (workspace_identity IS NULL OR TRIM(workspace_identity) = '')
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY workspace_path, task_id`,
      )
      .all({ provider: params.provider ?? null }) as TaskIndexMetaRow[];
    return rows.map((row) => {
      const meta = rowToMeta(row);
      return {
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity: meta.workspaceIdentity,
        deleted: row.deleted === 1,
        ...(meta.executionWorktree ? { executionWorktree: meta.executionWorktree } : {}),
      };
    });
  }

  /**
   * Converge execution-worktree facts from the live sessions-index overlay into meta_json (BUG-GWT-010,
   * docs/testing/git-worktree-qa/bugs/BUG-GWT-010.md). Only the meta_json column of existing rows changes,
   * so ordering (updated_at), status, and membership columns are never disturbed. Rows without a task-index
   * entry (draft sessions) and rows whose meta_json cannot be parsed are skipped: convergence must never
   * rewrite or replace data it does not understand.
   */
  private async applyExecutionWorktreeFacts(
    scope: { workspacePath: string; workspaceIdentity?: string },
    facts: ReadonlyArray<{ taskId: string; executionWorktree: ZCodeExecutionWorktree }>,
  ): Promise<void> {
    await Promise.all(
      facts.map((fact) =>
        this.enqueueWrite({ ...scope, taskId: fact.taskId }, () => {
          this.convergeTaskMetas(scope, [
            {
              taskId: fact.taskId,
              converged: (meta) => {
                const stored = meta.executionWorktree as ZCodeExecutionWorktree | undefined;
                return (
                  stored?.path === fact.executionWorktree.path &&
                  stored?.branchName === fact.executionWorktree.branchName
                );
              },
              patch: (meta) => ({ ...meta, executionWorktree: fact.executionWorktree }),
            },
          ]);
        }),
      ),
    );
  }

  /**
   * Persist incognito markers into meta_json (specs/incognito-session.md "Sidebar marker durability"). The profile
   * is frozen per session, so a stored `true` never goes stale: the write only ever adds the marker. `confirmed` holds
   * the ids whose row carries the marker after the call; `written` holds only the ids this call changed, so callers can
   * tell a real write (which must notify list readers) from a repeat confirmation. Absent, deleted and unreadable rows
   * are in neither; pinned and archived rows are included, because this method has no membership filter.
   */
  async persistIncognitoMarkers(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: ReadonlyArray<string>;
  }): Promise<{ confirmed: string[]; written: string[] }> {
    if (params.taskIds.length === 0) return { confirmed: [], written: [] };
    await this.ensureReady();
    const scope = {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    };
    // Queued per-task writes (for example a pending syncer write) must land before the marker is read.
    // Their completions never reject, so waiting on them cannot fail this call.
    await Promise.all(
      params.taskIds.map((taskId) => this.writeChains.get(this.writeKey({ ...scope, taskId }))),
    );
    // The convergence below is synchronous on the single node:sqlite connection, so one transaction covers every id.
    const { confirmed, written } = this.convergeTaskMetas(
      scope,
      params.taskIds.map((taskId) => ({
        taskId,
        converged: (meta) => meta.incognito === true,
        patch: (meta) => ({ ...meta, incognito: true }),
      })),
    );
    return { confirmed: Array.from(confirmed), written: Array.from(written) };
  }

  /**
   * Shared meta_json convergence protocol for the sessions-index overlay writers (worktree facts, incognito markers).
   * Each update targets one task row: `converged` reports that the stored meta already carries the fact, `patch`
   * builds the replacement meta. Only meta_json changes; absent, deleted, reservation-placeholder and non-object meta_json
   * rows are skipped, so they are not confirmed and the next publish retries them.
   * A read-only pass runs first so repeated publishes never take the write lock. The write pass re-reads after
   * BEGIN IMMEDIATE: enqueueWrite only serializes writers inside this process, and another Host sharing the database
   * can update the row between the read and the UPDATE. `confirmed` holds the task ids whose row carries the fact afterwards;
   * `written` is the subset this call's UPDATE changed (a row another Host already converged is confirmed but not written).
   */
  private convergeTaskMetas(
    scope: { workspacePath: string; workspaceIdentity?: string },
    updates: ReadonlyArray<TaskMetaConvergence>,
  ): { confirmed: Set<string>; written: Set<string> } {
    const database = this.getDatabase();
    const confirmed = new Set<string>();
    const written = new Set<string>();
    const readMeta = (taskId: string): Record<string, unknown> | null => {
      const row = this.getTaskRow({ ...scope, taskId });
      // Cause: a placeholder is not an admitted task yet. A fact written into its '{}' meta_json breaks the placeholder
      // signature (the row becomes a zero-time phantom that reads and discardCreatedTaskReservation no longer hide or
      // remove), and the admission write (applyCliFacts) then replaces the whole meta_json, erasing the fact while the
      // Host's acknowledgement set still reports it persisted.
      if (!row || row.deleted === 1 || isReservationPlaceholderRow(row)) return null;
      try {
        const parsed: unknown = JSON.parse(row.meta_json);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };
    const stale = updates.filter((update) => {
      const meta = readMeta(update.taskId);
      if (!meta) return false;
      if (update.converged(meta)) {
        confirmed.add(update.taskId);
        return false;
      }
      return true;
    });
    if (stale.length === 0) return { confirmed, written };

    const write = database.prepare(
      "UPDATE tasks SET meta_json = ? WHERE workspace_key = ? AND task_id = ?",
    );
    const key = workspaceKey(scope);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const update of stale) {
        const meta = readMeta(update.taskId);
        if (!meta) continue;
        if (!update.converged(meta)) {
          write.run(JSON.stringify(update.patch(meta)), key, update.taskId);
          written.add(update.taskId);
        }
        confirmed.add(update.taskId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { confirmed, written };
  }

  /**
   * Read deletion tombstones for a workspace.
   *
   * The CLI session store keeps session content. If list joins read only active/pinned/archived,
   * a deleted task is mistaken for an ordinary task because it is not archived and reappears after a cold start.
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /** Existence check for callers that only need "is there any task"; avoids materializing every row. */
  async hasTaskMetas(params: { includeDeleted?: boolean } = {}): Promise<boolean> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(
        `SELECT EXISTS(
          SELECT 1 FROM tasks WHERE (@include_deleted = 1 OR deleted = 0)
            AND NOT ${RESERVATION_PLACEHOLDER_SQL}
        ) AS found`,
      )
      .get({ include_deleted: params.includeDeleted ? 1 : 0 }) as { found: number } | undefined;
    return row?.found === 1;
  }

  /**
   * List all cron sessions produced by an automation (for expanded automation details and association queries).
   * Use the cron_automation_id index column; return only undeleted sessions in descending creation time.
   */
  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          meta_json
        FROM tasks
        WHERE cron_automation_id = @automation_id
          AND deleted = 0
        ORDER BY created_at DESC, task_id DESC`,
      )
      .all({ automation_id: automationId }) as unknown as TaskIndexMetaRow[];
    return rows.map(rowToMeta);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const scopes = params.workspaceScopes === "host" ? [] : params.workspaceScopes;
    const workspaceKeys = normalizeWorkspaceKeys(scopes);
    if (params.workspaceScopes !== "host" && workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = ["deleted = 0", `NOT ${RESERVATION_PLACEHOLDER_SQL}`];
    const args: Array<string | number> = [];
    if (params.workspaceScopes === "host") {
      // Legacy search relied on tabStore to trim the workspace, so history that was never reopened stayed invisible.
      // Query all tasks from the index owner, excluding other Host caches in the local database.
      where.push("host_id = ?");
      args.push(this.storageHostId ?? "local");
    } else {
      where.push(`workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`);
      args.push(...workspaceKeys);
    }
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else if (params.kind !== "all") {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // Previously, fuzzy matching searched only title and never matched chat body, so TaskSearchDialog could not find content.
      // Now a match in either title or searchable_text is sufficient; body snippets are built in the result stage.
      where.push(`(LOWER(${CLI_FACT_TITLE_SQL}) LIKE ? OR LOWER(searchable_text) LIKE ?)`);
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? `${CLI_FACT_CREATED_AT_SQL} DESC, ${CLI_FACT_UPDATED_AT_SQL} DESC, task_id DESC`
        : `${CLI_FACT_UPDATED_AT_SQL} DESC, ${CLI_FACT_CREATED_AT_SQL} DESC, task_id DESC`;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          cli_title,
          cli_created_at,
          cli_updated_at,
          cli_last_outcome,
          ${normalizedSearchLike ? "searchable_text," : ""}
          meta_json
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as Array<TaskIndexMetaRow & { searchable_text?: string }>;
    const workspacePurposeByKey = new Map(
      scopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const now = Date.now();
    const id = `task-group-${randomUUID()}`;
    const title = params?.title?.trim() || "New Group";
    const color = params?.color ?? DEFAULT_TASK_GROUP_COLOR;
    this.getDatabase()
      .prepare(
        `INSERT INTO task_groups (
          group_id,
          title,
          color,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, color, now, now);
    // New items must immediately enter user ordering and appear at the top of the current mixed list.
    // Do not mix created_at with existing sort_order; their different scales cause positions to drift after refresh.
    this.upsertGroupedTopOrder({
      nodeType: "group",
      nodeKey: id,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return {
      id,
      title,
      color,
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const title = params.title.trim() || "New Group";
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET title = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(title, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法重命名");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 重命名后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    if (!isTaskGroupColor(params.color)) {
      throw new Error("Task group 颜色无效");
    }
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET color = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(params.color, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法更新颜色");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 更新颜色后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database
        .prepare("DELETE FROM task_groups WHERE group_id = ?")
        .run(params.groupId);
      if (result.changes === 0) {
        throw new Error("Task group 不存在，无法删除");
      }
      database
        .prepare(
          `DELETE FROM task_group_view_node_orders
          WHERE node_type = 'group' AND node_key = ?`,
        )
        .run(params.groupId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return this.initializeGroupedTaskAtTopReady(params);
  }

  private initializeGroupedTaskAtTopReady(params: ZCodeGroupedTaskRef): boolean {
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
      return false;
    }
    const database = this.getDatabase();
    const existingMember = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
    const nodeKey = taskOrderNodeKey(params);
    const existingTopOrder = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nodeKey) as { found: number } | undefined;
    if (existingMember || existingTopOrder) {
      return false;
    }
    const now = Date.now();
    // Session visibility and a missing first-title row may concurrently trigger a full snapshot fetch.
    // Initialize top-level ordering only on first appearance; if repeated fetches allocate the minimum sort_order again,
    // a slower old task can move above a newer task, making final order depend on asynchronous completion timing.
    this.upsertGroupedTopOrder({
      nodeType: "task",
      nodeKey,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return true;
  }

  // Transitional surface: grouped lists now consume sessions-index + queryGroupedTaskViewStructure.
  // This method remains only to reuse the applyGroupedTaskViewOrder response (the UI no longer trusts that response);
  // remove it when the applyGroupedTaskViewOrder return surface is consolidated.
  async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const includeAllWorkspaces = params.includeAllWorkspaces === true;
    const requestedWorkspaceScopes = normalizeWorkspaceBootstrapScopes(params.workspaceScopes);
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    const activeTaskWhere = [
      "deleted = 0",
      `NOT ${RESERVATION_PLACEHOLDER_SQL}`,
      "archived = 0",
      "pinned = 0",
      ...(includeAllWorkspaces
        ? []
        : [`workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`]),
    ];
    const activeTaskArgs: Array<string | number> = includeAllWorkspaces ? [] : [...workspaceKeys];
    if (params.provider) {
      // Grouped and workspace are both ZCode Agent task-list entry points and must share the legacy-provider
      // filtering rule; otherwise indexed rows for historical third-party providers appear only in grouped.
      appendZCodeAgentIndexedProviderFilter(activeTaskWhere, activeTaskArgs, params.provider);
    }
    const activeTasks =
      !includeAllWorkspaces && workspaceKeys.length === 0
        ? []
        : (this.getDatabase()
            .prepare(
              `SELECT
                workspace_key,
                workspace_path,
                workspace_identity,
                task_id,
                title,
                task_status,
                provider,
                mode,
                model,
                migration_source,
                forked_from_task_id,
                cron_automation_id,
                created_at,
                updated_at,
                unread_at,
                pinned,
                archived,
                deleted,
                title_overridden,
                searchable_text,
                meta_json
              FROM tasks
              WHERE ${activeTaskWhere.join(" AND ")}`,
            )
            .all(...activeTaskArgs) as unknown as TaskIndexRow[]);
    const workspaceScopes = includeAllWorkspaces
      ? normalizeWorkspaceBootstrapScopes(
          activeTasks.map((row) => ({
            workspacePath: row.workspace_path,
            workspaceIdentity: row.workspace_identity ?? undefined,
          })),
        )
      : requestedWorkspaceScopes;
    this.bootstrapWorkspaceGroupsForActiveTasks({
      scopes: workspaceScopes,
      activeTasks,
    });
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const visibleWorkspaceKeys = new Set(
      includeAllWorkspaces ? activeTasks.map((task) => task.workspace_key) : workspaceKeys,
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const members = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const orderByNodeKey = new Map(
      orderRows.map((row) => [`${row.node_type}:${row.node_key}`, row]),
    );
    const memberByTaskKey = new Map(
      members.map((member) => [`${member.workspace_key}\u0000${member.task_id}`, member]),
    );
    const membersByGroupId = new Map<string, TaskGroupMemberRow[]>();
    for (const member of members) {
      const groupMembers = membersByGroupId.get(member.group_id) ?? [];
      groupMembers.push(member);
      membersByGroupId.set(member.group_id, groupMembers);
    }

    const activeTaskByKey = new Map(
      activeTasks.map((row) => [
        `${row.workspace_key}\u0000${row.task_id}`,
        rowToTaskListItem(row, null),
      ]),
    );
    const groupedVisibleTaskKeys = new Set<string>();
    const nodes: ZCodeGroupedTaskViewNode[] = groups.map((group) => {
      const groupTasks = (membersByGroupId.get(group.id) ?? [])
        .map((member) => activeTaskByKey.get(`${member.workspace_key}\u0000${member.task_id}`))
        .filter((task): task is ZCodeTaskListItem => Boolean(task));
      if (group.id === CRON_DEFAULT_GROUP_ID) {
        // The cron system group does not use user manual ordering; always show the latest result first by creation time.
        groupTasks.sort(compareCronGroupTasks);
      } else {
        this.normalizeGroupMemberOrders(group.id, groupTasks, memberByTaskKey);
        groupTasks.sort((left, right) => compareGroupTasks(left, right, memberByTaskKey));
      }
      for (const task of groupTasks) {
        groupedVisibleTaskKeys.add(taskNodeKey(task));
      }
      const order = orderByNodeKey.get(`group:${group.id}`);
      return {
        type: "group",
        group,
        tasks: groupTasks,
        ...(order ? { sortOrder: order.sort_order } : {}),
      };
    });

    for (const task of activeTaskByKey.values()) {
      const key = taskNodeKey(task);
      if (memberByTaskKey.has(key) || groupedVisibleTaskKeys.has(key)) {
        continue;
      }
      const order = orderByNodeKey.get(`task:${taskOrderNodeKey(task)}`);
      nodes.push({
        type: "task",
        task,
        ...(order ? { sortOrder: order.sort_order } : {}),
      });
    }

    // On the first query, initialize user ordering for all currently visible top-level nodes; subsequent display uses only sort_order.
    this.normalizeGroupedTopNodeOrders(nodes, orderByNodeKey);
    nodes.sort(compareGroupedNodes);
    return { nodes };
  }

  /**
   * Read the raw grouped structure (no join to tasks table and no bootstrap/normalization writes).
   * Task content now comes from sessions-index and is joined by the client; return only group/member/top-level ordering tables here.
   * Group visibility follows queryGroupedTaskView: a bootstrap workspace group is visible only in its workspace.
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    const visibleWorkspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const memberRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const members: ZCodeGroupedTaskViewStructureMember[] = memberRows.map((row) => ({
      groupId: row.group_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
      taskId: row.task_id,
      sortOrder: row.sort_order,
      addedAt: row.added_at,
    }));
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
    for (const row of orderRows) {
      if (row.node_type === "group") {
        topLevelOrders.push({
          type: "group",
          groupId: row.node_key,
          sortOrder: row.sort_order,
        });
        continue;
      }
      // task node_key = JSON.stringify([workspaceKey, taskId]); SQLite TEXT is truncated at NUL delimiters.
      try {
        const parsed = JSON.parse(row.node_key) as unknown;
        if (
          Array.isArray(parsed) &&
          typeof parsed[0] === "string" &&
          typeof parsed[1] === "string"
        ) {
          topLevelOrders.push({
            type: "task",
            workspaceKey: parsed[0],
            taskId: parsed[1],
            sortOrder: row.sort_order,
          });
        }
      } catch {
        // Skip malformed historical node_key values; the client fills in-memory order by createdAt, so it will not crash.
      }
    }
    return { groups, members, topLevelOrders };
  }

  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const workspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const now = Date.now();
    const database = this.getDatabase();

    const groupIds = new Set(
      (
        database.prepare("SELECT group_id FROM task_groups").all() as Array<{
          group_id: string;
        }>
      ).map((row) => row.group_id),
    );
    const validateTaskRef = (task: ZCodeGroupedTaskRef): string | null => {
      const key = workspaceKey(task);
      if (!workspaceKeys.has(key)) {
        throw new Error("Grouped task order 包含当前 scope 外的 task");
      }
      const row = this.getTaskRow(task);
      if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
        throw new Error("Grouped task order 包含不可见 task");
      }
      if (params.provider && row.provider !== params.provider) {
        // Before grouped save responses carried a provider boundary, stale ordering entries for old third-party providers could reappear after saving.
        // A provider-scoped ZCode Agent view accepts only the current glm task; skip old provider references as invisible legacy data.
        return null;
      }
      return key;
    };

    const topLevelTaskKeys = new Set<string>();
    const groupedTaskKeys = new Set<string>();
    const visibleTopLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[] = [];
    const visibleGroups: Array<{ groupId: string; taskRefs: ZCodeGroupedTaskRef[] }> = [];
    for (const node of params.topLevelNodes) {
      if (node.type === "group") {
        if (!groupIds.has(node.groupId)) {
          throw new Error("Grouped task order 包含不存在的 group");
        }
        visibleTopLevelNodes.push(node);
        continue;
      }
      const workspaceKey = validateTaskRef(node.task);
      if (!workspaceKey) {
        continue;
      }
      const key = `${workspaceKey}\u0000${node.task.taskId}`;
      topLevelTaskKeys.add(key);
      visibleTopLevelNodes.push(node);
    }
    for (const group of params.groups) {
      if (!groupIds.has(group.groupId)) {
        throw new Error("Grouped task order 包含不存在的 group");
      }
      const visibleTaskRefs: ZCodeGroupedTaskRef[] = [];
      for (const taskRef of group.taskRefs) {
        const workspaceKey = validateTaskRef(taskRef);
        if (!workspaceKey) {
          continue;
        }
        const key = `${workspaceKey}\u0000${taskRef.taskId}`;
        if (groupedTaskKeys.has(key)) {
          throw new Error("Grouped task order 不能让同一个 task 进入多个 group");
        }
        groupedTaskKeys.add(key);
        visibleTaskRefs.push(taskRef);
      }
      visibleGroups.push({ groupId: group.groupId, taskRefs: visibleTaskRefs });
    }

    const scopedTaskOrderKeys =
      workspaceKeys.size === 0
        ? []
        : (
            database
              .prepare(
                `SELECT workspace_key, task_id
              FROM tasks
              WHERE workspace_key IN (${[...workspaceKeys].map(() => "?").join(", ")})`,
              )
              .all(...workspaceKeys) as Array<{
              workspace_key: string;
              task_id: string;
            }>
          ).map((row) => `${row.workspace_key}\u0000${row.task_id}`);

    database.exec("BEGIN IMMEDIATE");
    try {
      const markWorkspaceBootstrapDisabled = database.prepare(
        `INSERT INTO task_group_workspace_bootstraps (
          workspace_key,
          group_id,
          created_at,
          updated_at
        ) VALUES (?, NULL, ?, ?)
        ON CONFLICT(workspace_key) DO UPDATE SET
          updated_at = excluded.updated_at`,
      );
      // Once the user explicitly saves grouped ordering, later queries must not automatically initialize workspaces.
      // Write a global marker here to prevent migration-style workspace group initialization when a new workspace appears.
      markWorkspaceBootstrapDisabled.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      const deleteMembership = database.prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      );
      const upsertMembership = database.prepare(
        `INSERT INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          group_id = excluded.group_id,
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      );
      for (const key of topLevelTaskKeys) {
        const [targetWorkspaceKey, taskId] = key.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          throw new Error("Grouped task order 顶层 task key 非法");
        }
        deleteMembership.run(targetWorkspaceKey, taskId);
      }
      for (const group of visibleGroups) {
        group.taskRefs.forEach((taskRef, index) => {
          const targetWorkspaceKey = workspaceKey(taskRef);
          upsertMembership.run(
            group.groupId,
            targetWorkspaceKey,
            taskRef.workspacePath,
            taskRef.workspaceIdentity ?? null,
            taskRef.taskId,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
        });
      }

      // Commit the final ordering once so grouped-view changes such as menu/draft/ungrouping do not leave partial writes.
      database.prepare("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'").run();
      const deleteTaskOrder = database.prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      );
      // Clear task ordering only in the current workspace scope; otherwise this change could delete mixed-list positions for remote/unexpanded workspaces.
      for (const nodeKey of scopedTaskOrderKeys) {
        const [targetWorkspaceKey, taskId] = nodeKey.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          continue;
        }
        deleteTaskOrder.run(JSON.stringify([targetWorkspaceKey, taskId]), targetWorkspaceKey);
      }
      const insertOrder = database.prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      visibleTopLevelNodes.forEach((node, index) => {
        const nodeType = node.type;
        const nodeKey = node.type === "group" ? node.groupId : taskOrderNodeKey(node.task);
        insertOrder.run(nodeType, nodeKey, (index + 1) * GROUPED_TASK_ORDER_STEP, now, now);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return this.queryGroupedTaskView({
      workspaceScopes: params.workspaceScopes,
      provider: params.provider,
    });
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
