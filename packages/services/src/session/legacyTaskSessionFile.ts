import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeSessionFileSchema, zcodeTaskMetaSchema, zcodeTaskModeSchema } from "@zcode/shared";

export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Claude native migration removes meta.mode through a sanitized path.
  // Legacy snapshot reads/writes must still validate other required fields, but must not force the filtered field back into the file.
  meta: zcodeTaskMetaSchema.extend({
    mode: zcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
