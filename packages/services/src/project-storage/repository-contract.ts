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
  /** Workspace the task belongs to; for a worktree task this is the project's main directory, not the cwd. */
  workspacePath: string;
  /** Task cwd; present only when it differs from workspacePath (managed worktree task, docs/git/worktree.md §6.6.1). */
  cwd?: string;
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
  /** Filters purely by CLI last activity time in a single transaction, excluding pinned tasks and activeTasks; archives and pauses bound scheduled tasks, and covers unassigned cwds. */
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
  /**
   * Atomically reserves ownership before the CLI create; a reservation row without facts does not enter the list, and a retry does not overwrite organization operations.
   * While the forked parent row has no owner yet (host_id NULL), returns null: no child row is written, and admitForkSummary claims it once the parent is owned.
   */
  reserveCreatedTask<T extends ReserveCreatedTaskInput>(input: T): ReserveCreatedTaskResult<T>;
  /**
   * Read-only lookup of creation receipts by creation command, without a workspace: the project's main directory may have changed by the retry, so the receipt and its task row are the only source of truth for the retry.
   * Returns each receipt's task directories (cwd does not change after creation); no receipts returns an empty array; an error is raised when a receipt's task no longer exists.
   */
  findCreationReceipts(input: {
    creationCommand: { clientId: string; commandId: string };
  }): Array<{ sessionId: string; directories: ProjectDirectories }>;
  /** The cwd recorded on the task row (`root_path`); returns null when there is no such row, never falling back to the workspace path. */
  readTaskCwd(task: ProjectTaskRef): string | null;
  /**
   * Revokes a creation reservation that has no CLI facts yet, together with its creation receipt (abandon or "do not use worktree" after worktree creation fails,
   * docs/git/worktree.md §3.5). released = revoked; absent = no such row; kept = the row already has CLI facts (the session exists) and is not deleted.
   */
  releaseReservedTask(input: { task: ProjectTaskRef }): "released" | "absent" | "kept";
  /**
   * Read-only: non-deleted tasks on this Host running in the given managed worktree (exact match on worktree_root),
   * used by the management dialog's "tasks using it" and the pre-delete occupancy check (docs/git/worktree.md §6.6.1).
   */
  listTasksByWorktree(input: {
    worktreeRoot: string;
  }): Array<ProjectTaskRef & { projectId: string | null; title: string; archived: boolean }>;
}

/** A plain create always resolves its directories; a fork resolves null while its parent has no owner yet. */
export type ReserveCreatedTaskResult<T extends ReserveCreatedTaskInput> = T extends {
  parentTaskId: string;
}
  ? ProjectDirectories & { taskId: string }
  : T extends {
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
      /** Managed worktree task cwd and worktree root (docs/git/worktree.md §6.6.1); both must be given together and only on the first reservation. */
      cwd?: string;
      worktreeRoot?: string;
      /**
       * Same-directory fork parent task ID (App Control fork reservation). When the parent runs in a managed worktree, the child row inherits
       * the parent's cwd, worktree root and additional directories in the same transaction (docs/git/worktree.md §3.6).
       */
      forkedFromTaskId?: string;
      forkOf?: undefined;
    }
  | {
      task: ProjectTaskRef;
      forkOf: ProjectTaskRef;
      projectId?: undefined;
      creationCommand?: undefined;
      additionalDirectories?: undefined;
    }
  | {
      /** Upstream 3.17.2 fork path: the child inherits the parent's project and directories when the ACK is handed over. */
      task: ProjectTaskRef;
      parentTaskId: string;
      forkOf?: undefined;
      projectId?: undefined;
      creationCommand?: undefined;
      additionalDirectories?: undefined;
    };
