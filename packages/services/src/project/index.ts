import type { FileEntry } from "@zcode/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectDataRepositoryContract } from "#src/project-storage/index.js";
import type {
  IProjectService,
  ProjectDataPort,
  ProjectDirectories,
  VirtualProject,
} from "#src/project/contract.js";
import { createProjectDataCommands } from "#src/project/data/project-data.js";
export {
  createProjectDataPort,
  type ProjectSessionDataAgent,
} from "#src/project/data/project-data-port.js";
export { IProjectService } from "#src/project/contract.js";
export { createLegacySingleRootProjectService } from "#src/project/legacy-single-root.js";
export {
  createTaskAutoArchiveScheduler,
  shouldRescanTaskAutoArchive,
} from "#src/project/autoArchiveScheduler.js";
export type {
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  ProjectRoot,
  SaveProjectInput,
  ProjectDirectories,
  ProjectDataPort,
  ProjectDataSession,
  ProjectDataMeasure,
  ProjectDataDeleteResult,
} from "#src/project/contract.js";

interface ProjectDirectoryPort {
  home(): Promise<string>;
  read(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
}

// Bug cause (ZCT-2113660144497782784): a directory stat may never return (e.g. macOS waiting for folder
// access permission, an unresponsive network drive). readTree/prepareSession used to stat again each time and
// wait indefinitely: the project tree and task creation never returned, and each retry took one more libuv
// thread until, after 4, every file operation in the process was stuck.
// Fix: while a previous stat on the same path has not returned, reuse it; if it still has not returned by the
// deadline counted from its first dispatch, return "unavailable". Once the stat returns, delete the record so
// the next read checks again — results are not cached.
const PRIMARY_ROOT_STATUS_TIMEOUT_MS = 30_000;
const inFlightPrimaryRootStats = new Map<string, { startedAt: number; result: Promise<Stats> }>();

function startPrimaryRootStat(path: string) {
  const flight = { startedAt: Date.now(), result: stat(path) };
  const clear = () => {
    if (inFlightPrimaryRootStats.get(path) === flight) inFlightPrimaryRootStats.delete(path);
  };
  flight.result.then(clear, clear);
  inFlightPrimaryRootStats.set(path, flight);
  return flight;
}

async function readPrimaryRootStatus(
  path: string,
): Promise<NonNullable<VirtualProject["primaryRootStatus"]>> {
  const flight = inFlightPrimaryRootStats.get(path) ?? startPrimaryRootStat(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(
      () => resolve(null),
      Math.max(0, flight.startedAt + PRIMARY_ROOT_STATUS_TIMEOUT_MS - Date.now()),
    );
  });
  try {
    const stats = await Promise.race([flight.result, deadline]);
    if (!stats) return "unavailable";
    return stats.isDirectory() ? "available" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

async function projectPrimaryRootStatuses(projects: VirtualProject[]): Promise<VirtualProject[]> {
  // Primary-directory existence is a filesystem fact; rederive it on every read and never freeze stale
  // post-delete/post-restore values into SQLite. Checks of the same primary root reuse the in-flight stat
  // inside readPrimaryRootStatus, so no extra dedup is needed here.
  return Promise.all(
    projects.map(async (project) => {
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      if (!primary || project.deleted) return project;
      return { ...project, primaryRootStatus: await readPrimaryRootStatus(primary) };
    }),
  );
}

const saveProjectSchema = z
  .object({
    reuseExistingRoot: z.boolean().optional(),
    id: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    restoreProjectId: z.string().min(1).optional(),
    name: z.string().optional(),
    defaultName: z.string().optional(),
    roots: z.array(z.string().min(1)).optional(),
    primaryRoot: z.string().min(1).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  // Open-directory intent: one local root, no other fields. Keeps the open path from creating duplicate projects.
  .refine(
    (value) =>
      !value.reuseExistingRoot ||
      (value.roots?.length === 1 &&
        (!value.hostId || value.hostId === "local") &&
        Object.keys(value).every((key) => ["roots", "hostId", "reuseExistingRoot"].includes(key))),
    "project.invalid-directory-open",
  )
  .refine((value) => !(value.id && value.restoreProjectId), "project.ambiguous-save")
  .refine(
    (value) => !value.restoreProjectId || value.roots !== undefined,
    "project.restore-roots-required",
  );

export function createProjectService(options: {
  repository(): Promise<ProjectRepositoryContract>;
  workspaceDirectory: string;
  ownerHostId?: string;
  directories?: ProjectDirectoryPort;
  /** Resolves existing connections only; a missing connection is rejected, no substitute Host is created. */
  resolveHost?: (hostId: string) => Promise<IProjectService>;
  afterChange?: () => Promise<void>;
  /** Permanent data deletion: side-effect port plus row operations on the same Host; when absent, both commands report project.data-unavailable. */
  data?: { port: ProjectDataPort; repository(): Promise<ProjectDataRepositoryContract> };
}): IProjectService {
  const route = async (hostId?: string) => {
    if (!hostId || hostId === (options.ownerHostId ?? "local")) return null;
    if (!options.resolveHost) throw new Error("project.host-offline");
    return options.resolveHost(hostId);
  };
  const creationFlights = new Map<string, Promise<ProjectDirectories>>();
  const changed = async () => {
    await options.afterChange?.();
  };
  const service: IProjectService = {
    ...createProjectDataCommands({ ...options, changed }),
    async readDirectory(params = {}) {
      const input = z
        .object({
          hostId: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
          includeHidden: z.boolean().optional(),
        })
        .strict()
        .parse(params);
      const remote = await route(input.hostId);
      if (remote) return remote.readDirectory(input);
      if (!options.directories) throw new Error("project.directory-service-unavailable");
      const requestedPath = input.path ?? (await options.directories.home());
      if (!isAbsolute(requestedPath)) throw new Error("project.absolute-path-required");
      // Directory matching must follow the same rules this Host uses to save roots; the controller must not interpret remote paths by its own OS.
      const path = normalize(requestedPath);
      return {
        path,
        entries: await options.directories.read({
          path,
          ...(input.includeHidden !== undefined ? { includeHidden: input.includeHidden } : {}),
        }),
      };
    },
    async readProjects(params) {
      const remote = await route(params?.hostId);
      return remote
        ? remote.readProjects({ includeDeleted: params?.includeDeleted })
        : projectPrimaryRootStatuses(
            (await options.repository()).readTree({
              includeDeleted: params?.includeDeleted,
              includeTasks: false,
            }).projects,
          );
    },
    async readTree(params) {
      const remote = await route(params?.hostId);
      if (remote)
        return remote.readTree({
          includeDeleted: params?.includeDeleted,
          includeDeletedTasks: params?.includeDeletedTasks,
        });
      // Read-only: auto-archiving runs on a timer in autoArchiveScheduler; reads and clicks never change `archived`.
      const tree = (await options.repository()).readTree({
        includeDeleted: params?.includeDeleted,
        includeDeletedTasks: params?.includeDeletedTasks,
      });
      return { ...tree, projects: await projectPrimaryRootStatuses(tree.projects) };
    },
    async saveProject(input) {
      input = saveProjectSchema.parse(input);
      if (input.reuseExistingRoot && options.ownerHostId && options.ownerHostId !== "local")
        throw new Error("project.invalid-directory-open");
      const remote = await route(input.hostId);
      if (remote) return remote.saveProject(input);
      const roots = input.roots
        ? [
            ...new Set(
              input.roots.map((path) => {
                if (!isAbsolute(path)) throw new Error("project.absolute-path-required");
                return normalize(path);
              }),
            ),
          ]
        : undefined;
      await Promise.all(
        (roots ?? []).map(async (path) => {
          if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
        }),
      );
      const result = (await options.repository()).saveProject({
        ...input,
        roots,
        ...(input.primaryRoot ? { primaryRoot: normalize(input.primaryRoot) } : {}),
      });
      await changed();
      return result;
    },
    async deleteProject(id, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.deleteProject(id);
      (await options.repository()).deleteProject(id);
      await changed();
    },
    async restoreProject(id, hostId) {
      z.string().min(1).parse(id);
      const remote = await route(hostId);
      if (remote) return remote.restoreProject(id);
      const repository = await options.repository();
      const project = repository
        .readTree({ includeDeleted: true, includeTasks: false })
        .projects.find((item) => item.id === id);
      if (!project) throw new Error("project.not-found");
      if (!project.deleted) return project;
      // Reuse the creation-time "restore" write path: pass roots back verbatim, and the repository keeps the
      // primary directory, pins, ordering, and handles name collisions; skipping saveProject's directory
      // validation is required, otherwise a project whose folder no longer exists could not be undeleted.
      const result = repository.saveProject({
        restoreProjectId: id,
        roots: project.roots.map((root) => root.rootPath),
      });
      await changed();
      return result;
    },
    async moveTask(input) {
      const remote = await route(input.hostId);
      if (remote)
        return remote.moveTask({
          task: input.task,
          projectId: input.projectId,
          addMissingRoot: input.addMissingRoot,
        });
      // Confirming an added missing root must also validate the directory; dragging must not bypass the existence constraint on newly added directories.
      if (input.addMissingRoot && !(await stat(input.task.workspacePath)).isDirectory())
        throw new Error("project.directory-required");
      (await options.repository()).moveTask(input);
      await changed();
    },
    async reorderProjects(ids, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.reorderProjects(ids);
      (await options.repository()).reorderProjects(ids);
      await changed();
    },
    async resolveSessionDirectories(task, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.resolveSessionDirectories(task);
      return (await options.repository()).resolveSessionDirectories(task);
    },
    async prepareSession(params) {
      const draftId =
        params?.draftId === undefined ? undefined : z.string().uuid().parse(params.draftId);
      if ((draftId && params?.projectId) || (params?.reuseDraft && !draftId))
        throw new Error("project.invalid-draft-target");
      const remote = await route(params?.hostId);
      if (remote) return remote.prepareSession({ projectId: params?.projectId });
      const id = params?.projectId;
      const remoteOwner = Boolean(options.ownerHostId && options.ownerHostId !== "local");
      // An old entry point could bypass the project and mkdir remotely; reject before any directory or session side effects.
      if (remoteOwner && !id) throw new Error("project.remote-project-required");
      if (id && creationFlights.has(id)) return creationFlights.get(id)!;
      const flight = (async (): Promise<ProjectDirectories> => {
        if (!id) {
          // The draft id is persisted client-side first; repeated clicks, lost replies, and restart retries
          // all prepare the same directory. Calls without a draftId (automation/Bots etc.) still allocate
          // independently and must never globally reuse the latest directory.
          const path = join(
            options.workspaceDirectory,
            draftId ? `draft-${draftId}` : `${Date.now()}-${randomUUID()}`,
          );
          // If a delivered directory was moved away, only report it missing; never silently recreate an empty one with mkdir.
          if (params?.reuseDraft) {
            if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
          } else await mkdir(path, { recursive: true });
          return { workspacePath: path, additionalDirectories: [], projectId: null };
        }
        const repo = await options.repository();
        // Creation needs only the project record; reading full task history would block draft navigation, and the recheck below uses the same project-scoped read.
        let project = repo
          .readTree({ includeTasks: false })
          .projects.find((item) => item.id === id);
        if (!project) throw new Error("project.not-found");
        if (remoteOwner && project.roots.length !== 1)
          throw new Error("project.remote-single-root-required");
        if (!project.roots.length) {
          // Multiple windows generate the same directory for the same empty project, without cross-process timing locks.
          const path = join(options.workspaceDirectory, id);
          await mkdir(path, { recursive: true });
          // The empty check and the INSERT must share one write transaction so another Host's roots edit is not overwritten.
          project = repo.initializeProjectRoot(id, path);
          await changed();
        }
        const workspacePath = project.roots.find((root) => root.isPrimary)?.rootPath;
        if (!workspacePath) throw new Error("project.primary-root-missing");
        // The primary directory may still be moved away between the project tree and the click; the creation entry must recheck instead of reviving the old path with mkdir or switching to an additional directory.
        const primaryRootStatus = await readPrimaryRootStatus(workspacePath);
        if (primaryRootStatus !== "available") {
          throw new Error(
            primaryRootStatus === "missing"
              ? "project.primaryRootMissing"
              : "project.primaryRootUnavailable",
          );
        }
        // The directory check yields the thread; if the project was deleted meanwhile, never return the stale ownership usable for first dispatch.
        if (
          !repo
            .readTree({ includeTasks: false })
            .projects.some((item) => item.id === id && !item.deleted)
        )
          throw new Error("project.not-found");
        return {
          projectId: id,
          workspacePath,
          additionalDirectories: project.roots
            .map((root) => root.rootPath)
            .filter((path) => path !== workspacePath),
        };
      })();
      if (id) creationFlights.set(id, flight);
      try {
        return await flight;
      } finally {
        if (id && creationFlights.get(id) === flight) creationFlights.delete(id);
      }
    },
  };
  return service;
}

/** The outward tree uses identities already registered by the attachment; the actual cwd and the remote canonical key are not rewritten. */
export function bindRemoteProjectIdentities(
  service: IProjectService,
  resolveIdentity: (workspacePath: string) => Promise<string>,
): IProjectService {
  return {
    readProjects: (params) => service.readProjects(params),
    async readTree(params) {
      const tree = await service.readTree(params);
      // Even an empty project subscribes to sidebar state immediately. If only the task cwd were prepared,
      // the first subscription would pin to an unmapped emitter and could not rebind once a directory opened
      // later and established the mapping; prepare all subscribed directories before publishing the tree.
      const paths = [
        ...new Set([
          ...tree.projects.flatMap((project) => project.roots.map((root) => root.rootPath)),
          ...tree.tasks.map((task) => task.workspacePath),
        ]),
      ];
      const identities = new Map(
        await Promise.all(paths.map(async (path) => [path, await resolveIdentity(path)] as const)),
      );
      return {
        ...tree,
        tasks: tree.tasks.map((task) => ({
          ...task,
          workspaceIdentity: identities.get(task.workspacePath)!,
        })),
      };
    },
    readDirectory: (params) => service.readDirectory(params),
    saveProject: (input) => service.saveProject(input),
    deleteProject: (id, hostId) => service.deleteProject(id, hostId),
    restoreProject: (id, hostId) => service.restoreProject(id, hostId),
    moveTask: (input) => service.moveTask(input),
    reorderProjects: (ids, hostId) => service.reorderProjects(ids, hostId),
    measureProjectData: (ids, hostId) => service.measureProjectData(ids, hostId),
    deleteProjectData: (id, hostId) => service.deleteProjectData(id, hostId),
    async prepareSession(params) {
      const directories = await service.prepareSession(params);
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
    async resolveSessionDirectories(task, hostId) {
      const directories = await service.resolveSessionDirectories(task, hostId);
      // Restoring an existing task once missed backfilling the remote identity, so the same cwd was rejected
      // by navigation isolation checks. Resolve the identity from the owning Host's real returned directory —
      // do not copy the request identity or relax navigation validation.
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
  };
}

/**
 * Deduplicates remote identity registration by physical-connection generation; the assembler wraps the
 * resolver passed to `bindRemoteProjectIdentities` with this.
 *
 * Bug cause: since 3.16, every remote readTree, resolveSessionDirectories, and prepareSession re-invoked the
 * remote resolveWorkspace once per path. Registration only writes the stable → canonical mapping table inside
 * the Server Core process — re-registering within the same connection changes no state, yet it added one more
 * serial SSH round trip to directory resolution before every send, and made the remote open two SQLite
 * databases per sync.
 *
 * Fix: the mapping table lives and dies with the Core process and only grows; a Core restart always breaks the
 * connection, and the Host then gets a new physical connection object. So caching registration results by the
 * physical connection object is enough — no timeout needed. Failed registrations are not cached; the next
 * read registers again.
 */
export function createRemoteIdentityRegistrationCache(): (
  physicalConnection: object,
  workspacePath: string,
  register: () => Promise<string>,
) => Promise<string> {
  const byConnection = new WeakMap<object, Map<string, Promise<string>>>();
  return (physicalConnection, workspacePath, register) => {
    const byPath = byConnection.get(physicalConnection) ?? new Map<string, Promise<string>>();
    byConnection.set(physicalConnection, byPath);
    const registered = byPath.get(workspacePath);
    if (registered) return registered;
    const flight = register();
    byPath.set(workspacePath, flight);
    // The caller receives the failure as usual; only the cache entry is deleted here so the next read registers again.
    flight.catch(() => {
      if (byPath.get(workspacePath) === flight) byPath.delete(workspacePath);
    });
    return flight;
  };
}
