import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  IQuickPromptService,
  QUICK_PROMPT_BODY_MAX_LENGTH,
  QUICK_PROMPT_COLORS,
  QUICK_PROMPT_LIST_LIMIT,
  QUICK_PROMPT_NAME_MAX_LENGTH,
} from "#src/quick-prompts/contract.js";
import { ensureQuickPromptSchema } from "#src/quick-prompts/migration.js";
import { QuickPromptRepository } from "#src/quick-prompts/repository.js";

const log = createServiceLogger("quick-prompts");

const isJsonArray = (value: string): boolean => {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
};

const nameSchema = z
  .string()
  .trim()
  .min(1, "quick-prompt.name-required")
  .max(QUICK_PROMPT_NAME_MAX_LENGTH, "quick-prompt.name-too-long");
const bodySchema = z
  .object({
    // A blank body would overwrite a stored prompt with nothing (the editor reports an empty body when its stored
    // nodes failed to load), so every write requires visible text.
    markdown: z
      .string()
      .max(QUICK_PROMPT_BODY_MAX_LENGTH, "quick-prompt.body-too-long")
      .refine((markdown) => markdown.trim().length > 0, "quick-prompt.body-required"),
    nodes: z.string().refine(isJsonArray, "quick-prompt.body-nodes-invalid"),
  })
  .strict();
const projectSchema = z
  .object({ hostId: z.string().min(1), projectId: z.string().min(1) })
  .strict();
// An unknown hue degrades to none instead of failing the whole write (spec "Color value contract").
const colorSchema = z.enum(QUICK_PROMPT_COLORS).nullable().catch(null);
const scopeSchema = z.enum(["global", "project"]);
const idSchema = z.string().min(1);
const scopeMismatch = "quick-prompt.scope-mismatch";
const consistent = (value: { scope: "global" | "project"; project: unknown }) =>
  (value.scope === "global") === (value.project === null);

const readSchema = z.object({ project: projectSchema.nullable() }).strict();
const createSchema = z
  .object({
    scope: scopeSchema,
    project: projectSchema.nullable(),
    name: nameSchema,
    body: bodySchema,
    color: colorSchema.optional(),
    pinned: z.boolean(),
  })
  .strict()
  .refine(consistent, scopeMismatch);
const updateSchema = z
  .object({
    promptId: idSchema,
    name: nameSchema.optional(),
    body: bodySchema.optional(),
    color: colorSchema.optional(),
    scope: scopeSchema.optional(),
    project: projectSchema.nullable().optional(),
  })
  .strict();
const duplicateSchema = z
  .object({
    promptId: idSchema,
    scope: scopeSchema,
    project: projectSchema.nullable(),
  })
  .strict()
  .refine(consistent, scopeMismatch);
const deleteSchema = z.object({ promptId: idSchema }).strict();
const pinSchema = z.object({ promptId: idSchema, pinned: z.boolean() }).strict();
const hiddenSchema = z
  .object({ promptId: idSchema, project: projectSchema, hidden: z.boolean() })
  .strict();
const reorderSchema = z
  .object({
    scope: scopeSchema,
    project: projectSchema.nullable(),
    orderedIds: z.array(idSchema).max(QUICK_PROMPT_LIST_LIMIT),
  })
  .strict()
  .refine(consistent, scopeMismatch);

/** Shape validation happens before the transaction; every rule that depends on stored rows runs inside it. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "quick-prompt.invalid-input");
  }
  return result.data;
}

export interface QuickPromptServiceOptions {
  database(): Promise<DatabaseSync>;
  /** Called only after a write commits; the receivers re-read, so the payload is empty. */
  afterChange(): Promise<void> | void;
}

export function createQuickPromptService(options: QuickPromptServiceOptions): IQuickPromptService {
  const repository = async () => {
    const db = await options.database();
    ensureQuickPromptSchema(db);
    return new QuickPromptRepository(db);
  };
  const write = async <T>(
    action: string,
    run: (repo: QuickPromptRepository) => T,
    committed: (result: T) => boolean = () => true,
  ): Promise<T> => {
    const result = run(await repository());
    log.debug(undefined, "quick prompt write committed", { action });
    if (committed(result)) await options.afterChange();
    return result;
  };
  return {
    async read(input) {
      const { project } = parse(readSchema, input);
      return (await repository()).read(project);
    },
    async readProjects() {
      return (await repository()).readProjects();
    },
    async create(input) {
      const parsed = parse(createSchema, input);
      return write("create", (repo) => repo.create(parsed));
    },
    async update(input) {
      const parsed = parse(updateSchema, input);
      return write("update", (repo) => repo.update(parsed));
    },
    async delete(input) {
      const { promptId } = parse(deleteSchema, input);
      await write(
        "delete",
        (repo) => repo.delete(promptId),
        (deleted) => deleted,
      );
    },
    async duplicate(input) {
      const parsed = parse(duplicateSchema, input);
      return write("duplicate", (repo) => repo.duplicate(parsed));
    },
    async setPinned(input) {
      const parsed = parse(pinSchema, input);
      await write("setPinned", (repo) => repo.setPinned(parsed.promptId, parsed.pinned));
    },
    async setHidden(input) {
      const parsed = parse(hiddenSchema, input);
      await write("setHidden", (repo) =>
        repo.setHidden(parsed.promptId, parsed.project, parsed.hidden),
      );
    },
    async reorder(input) {
      const parsed = parse(reorderSchema, input);
      await write("reorder", (repo) =>
        repo.reorder({ scope: parsed.scope, project: parsed.project }, parsed.orderedIds),
      );
    },
  };
}
