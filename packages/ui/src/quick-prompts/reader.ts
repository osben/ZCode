/**
 * Request-serial reader for quick prompt snapshots (the useTaskGroups pattern): every load bumps the serial, and a
 * response whose serial is no longer the latest is dropped. The database is the only truth, so a broadcast only
 * tells receivers to re-read; nothing read here is cached across loads.
 */
import type { QuickPromptProjectRef, QuickPromptSnapshot } from "./contract.js";

export type QuickPromptReadResult =
  | { projectKey: string; snapshot: QuickPromptSnapshot }
  | { projectKey: string; error: unknown };

export interface QuickPromptReaderOptions {
  read: (project: QuickPromptProjectRef | null) => Promise<QuickPromptSnapshot>;
  publish: (result: QuickPromptReadResult) => void;
}

/** Stable key for a project pair. Both ids are kept apart, so ids containing ":" cannot collide. */
export function quickPromptProjectKey(project: QuickPromptProjectRef | null): string {
  return project ? JSON.stringify([project.hostId, project.projectId]) : "";
}

/** Inverse of quickPromptProjectKey; the empty key is the "no project" state. */
export function parseQuickPromptProjectKey(key: string): QuickPromptProjectRef | null {
  if (!key) return null;
  const [hostId, projectId] = JSON.parse(key) as [string, string];
  return { hostId, projectId };
}

export function createQuickPromptReader(options: QuickPromptReaderOptions) {
  let serial = 0;
  return {
    async load(project: QuickPromptProjectRef | null): Promise<void> {
      const request = ++serial;
      const projectKey = quickPromptProjectKey(project);
      try {
        const snapshot = await options.read(project);
        if (request === serial) options.publish({ projectKey, snapshot });
      } catch (error: unknown) {
        if (request === serial) options.publish({ projectKey, error });
      }
    },
    /** Called on unmount or when the service changes: every in-flight response is then stale. */
    invalidate(): void {
      serial++;
    },
  };
}
