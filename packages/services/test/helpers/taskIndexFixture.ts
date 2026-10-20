import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

/**
 * Seeds one task row through the fork's single task-index writer (`syncTaskMeta`).
 * The fork has no CLI-facts writer on TaskIndexRepo, so tests that need a seeded row
 * go through the same full-row path that production uses for the current fork schema.
 */
export async function seedTaskIndex(
  repo: TaskIndexRepo,
  input: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  },
): Promise<ZCodeTaskMeta> {
  const { meta } = input;
  await repo.syncTaskMeta({
    meta,
    pinned: input.pinned,
    archived: input.archived,
    deleted: input.deleted,
    titleOverridden: input.titleOverridden ?? meta.titleOverridden,
    searchableText: input.searchableText,
  });
  return (await repo.getTaskMeta(meta))!;
}
