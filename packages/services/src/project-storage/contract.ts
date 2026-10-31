import type {
  ProjectRepositoryContract,
  ProjectTaskRef,
} from "#src/project-storage/repository-contract.js";
export * from "#src/project-storage/repository-contract.js";
import type { DatabaseSync } from "node:sqlite";
import type { AppSettings } from "@zcode/shared";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";

export interface ProjectMigrationContext {
  /** Trusted Server identity of the owning Host; not affected by client requests or legacy canonical routes. */
  hostId?: string;
  backupDirectories: readonly string[];
  settings?: Pick<
    AppSettings,
    "lastWorkspaceSession" | "recentProjects" | "sourceServers" | "connectionProfiles"
  >;
  now?: () => number;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

/** Versioned migration port for the Host database; never reads or modifies the CLI db.sqlite. */
export interface ProjectStorageContract {
  /** After the additive upgrade, hands off rows added, deleted, and title intents from the old version in the same transaction; called on every startup, and already-processed NULLs are not recomputed. */
  migrate(db: DatabaseSync, context: ProjectMigrationContext): Promise<MigrationResult>;
  repository(db: DatabaseSync, hostId?: string): ProjectRepositoryContract;
  admitTaskIdentity(db: DatabaseSync, task: ProjectTaskRef, hostId?: string): void;
}
