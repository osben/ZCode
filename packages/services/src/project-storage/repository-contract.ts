import type { ProjectReservationCleanupContract } from "#src/project-storage/reservation-contract.js";

export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}
export interface VirtualProject {
  /** Read-only projection probed asynchronously from the owning Host; not written to the project database or the remote entry cache. Old Servers may omit it. */
  primaryRootStatus?: "available" | "missing" | "unavailable";
  /** Read-only single-root projection from an old Server; not a locally persisted project. */
  legacySingleRoot?: true;
  /** Directory match value derived from the old single root under the owning Host's rules; not stored, and it does not change the original root, project ID, or task cwd. */
  directoryMatchPath?: string;
  id: string;
  hostId: string;
  name: string;
  nameOverridden: boolean;
  roots: ProjectRoot[];
  position: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ProjectTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
export type ProjectTask = import("@zcode/shared").ZCodeTaskMeta & {
  projectId: string | null;
  hostId: string;
  pinned: boolean;
  archived: boolean;
};
export interface ProjectTree {
  legacySingleRoot?: true;
  projects: VirtualProject[];
  tasks: ProjectTask[];
  /** Returns deletion facts only when explicitly requested; an offline absence cannot replace these references. */
  deletedTasks?: Array<ProjectTaskRef & { hostId: string }>;
}

export const LEGACY_SINGLE_ROOT_PROJECT_PREFIX = "legacy-single-root:";
export interface SaveProjectInput {
  id?: string;
  hostId?: string;
  name?: string;
  defaultName?: string;
  roots?: string[];
  primaryRoot?: string;
  pinned?: boolean;
  restoreProjectId?: string;
  /**
   * Open-directory intent: return the local project already bound to this single root instead of creating a
   * duplicate. Only valid for one local root with no other fields (see the project service schema).
   */
  reuseExistingRoot?: boolean;
}
export interface ProjectDirectories {
  workspacePath: string;
  /** Attachment identity registered by the remote assembly layer; execution still uses workspacePath. */
  workspaceIdentity?: string;
  additionalDirectories: string[];
  projectId: string | null;
}
export interface AutoArchiveInput {
  cutoff: number;
  activeTasks: readonly ProjectTaskRef[];
}
/** Project organization repository contract; migration and assembly contracts stay in contract.ts, and the public import path is unchanged. */
export interface ProjectRepositoryContract extends ProjectReservationCleanupContract {
  /** Read on the CLI's first allocation; soft-deleted projects and historical tasks of removed roots keep their project ownership. */
  hasProjectWorkspace(workspace: { workspacePath: string; workspaceIdentity?: string }): boolean;
  /** Filters purely by CLI last activity time in a single transaction, excluding pinned tasks and activeTasks; writes only organization state and covers unassigned cwds. */
  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[];
  /** May fetch directories only, and participates in the caller's existing SQLite read snapshot. */
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree;
  saveProject(input: SaveProjectInput): VirtualProject;
  deleteProject(id: string): void;
  /** Initializes roots only for an empty project inside the write transaction; directories added by a concurrent edit take precedence. */
  initializeProjectRoot(id: string, path: string): VirtualProject;
  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void;
  reorderProjects(ids: string[]): void;
  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories;
  /**
   * Atomically reserves ownership before the CLI create; a reservation row without facts does not enter the list, and a retry does not overwrite organization operations.
   * While the forked parent row has no owner yet (host_id NULL), returns null: no child row is written, and admitForkSummary claims it once the parent is owned.
   */
  reserveCreatedTask<T extends ReserveCreatedTaskInput>(input: T): ReserveCreatedTaskResult<T>;
}

/** A plain create always resolves its directories; a fork resolves null while its parent has no owner yet. */
export type ReserveCreatedTaskResult<T extends ReserveCreatedTaskInput> = T extends {
  forkOf: ProjectTaskRef;
}
  ? ProjectDirectories | null
  : ProjectDirectories & { taskId: string };

/**
 * A plain create names its project and directories. A fork names only its parent: the child takes over the parent's
 * project, cwd and resolved directories, and a row that already has an owner is left unchanged. An unowned parent gives no claim (null).
 */
export type ReserveCreatedTaskInput =
  | {
      /** Without a taskId the Host allocates the session ID under creationCommand. */
      task: Omit<ProjectTaskRef, "taskId"> & { taskId?: string };
      projectId: string | null;
      /** Creation identity receipt; does not own CLI command execution or the ACK decision. */
      creationCommand?: { clientId: string; commandId: string };
      /** Execution directories frozen by the Host; persisted on the first reservation and unchanged on retry. undefined means a plain create. */
      additionalDirectories?: string[];
      forkOf?: undefined;
    }
  | {
      task: ProjectTaskRef;
      forkOf: ProjectTaskRef;
      projectId?: undefined;
      creationCommand?: undefined;
      additionalDirectories?: undefined;
    };
