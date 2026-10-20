import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

/**
 * Seeds one task row through the fork's organization writer (`syncTaskMeta`), then records the CLI facts
 * (`applyCliFacts`). Production admits CLI facts through the CLI path; this helper mirrors that path so the
 * read projection (`cli_*` columns) and the alias merge see the same facts a real CLI-admitted row carries.
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
  await repo.applyCliFacts({
    meta,
    titleSource: (input.titleOverridden ?? meta.titleOverridden) ? "custom" : "default",
    lastOutcome: meta.status === "completed" || meta.status === "error" ? meta.status : undefined,
    deleted: input.deleted,
  });
  return (await repo.getTaskMeta(meta))!;
}
