import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const providerFamilyConnectionSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start-plan") }).strict(),
  z.object({ kind: z.literal("individual-coding-plan") }).strict(),
  z
    .object({
      kind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);

export const providerFamilyConnectionSelectionSettingsSchema = z
  .object({
    zai: providerFamilyConnectionSelectionSchema.optional(),
    bigmodel: providerFamilyConnectionSelectionSchema.optional(),
  })
  .partial();

/** User's connection-selection intent for a Provider Family; contains no account identity or dynamic credentials. */
export type ProviderFamilyConnectionSelection = Readonly<
  z.infer<typeof providerFamilyConnectionSelectionSchema>
>;

export type ProviderFamilyConnectionSelectionSettings = z.infer<
  typeof providerFamilyConnectionSelectionSettingsSchema
>;
