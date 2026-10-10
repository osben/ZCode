import { z } from "zod";

/**
 * Single authoritative schema for the Workspace Hook Trust store format (`workspace-hook-trust-v1.json`).
 *
 * The complete schema cannot live only in contracts (CLI side, zod3):
 * the services layer cannot depend on packages under apps, so it would have to hand-write partial field checks (only for
 * workspaceIdentity and digest shape). The same store file with "valid JSON but invalid structure" would then be deemed corrupt by
 * runtime/adapters (fail-closed, blocking everything), while services would display its digest as trusted — the UI would show "trusted" while the execution layer always rejects,
 * with no unified path for diagnosis. Trust storage is a permission boundary, so every consumer must reach the same conclusion for the same
 * file. Therefore, the schema moves to shared as the single source of truth, and contracts re-exports this module to preserve existing import paths.
 *
 * Note: contracts and this module use separate zod3/zod4 instances. This schema must not be composed into
 * a zod3 schema inside contracts (currently it is only re-exported, not composed).
 */

export const WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION = 1 as const;

/** Keep in sync with the contracts workspaceHookEventNameSchema (7 existing events). */
const workspaceHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const workspaceHookTrustRecordSchema = z
  .object({
    workspaceIdentity: nonEmptyStringSchema,
    hookDeclarationDigest: sha256DigestSchema,
    digestAlgorithm: z.literal("sha256"),
    decision: z.literal("trusted"),
    grantedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
    bundleDigestAtGrant: sha256DigestSchema.optional(),
    eventAtGrant: workspaceHookEventNameSchema,
    displayCommandAtGrant: nonEmptyStringSchema,
    sourcePathAtGrant: nonEmptyStringSchema,
    sourceDiscoveryOrderAtGrant: nonnegativeIntegerSchema.optional(),
    matcherAtGrant: z.string().nullable().optional(),
    matcherIndexAtGrant: nonnegativeIntegerSchema.optional(),
    hookIndexAtGrant: nonnegativeIntegerSchema.optional(),
    appVersionAtGrant: nonEmptyStringSchema.optional(),
  })
  .strict();
export type WorkspaceHookTrustRecord = z.infer<typeof workspaceHookTrustRecordSchema>;

export const workspaceHookTrustStoreFileSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION),
    records: z.array(workspaceHookTrustRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const keys = store.records.map(
      (record) => `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["records"],
        message: "workspace identity and declaration digest keys must be unique",
      });
    }
  });
export type WorkspaceHookTrustStoreFile = z.infer<typeof workspaceHookTrustStoreFileSchema>;

export type WorkspaceHookTrustStoreParseResult =
  | { status: "ok"; file: WorkspaceHookTrustStoreFile }
  | { status: "invalid" };

/**
 * Parse trust store file contents. JSON syntax errors and schema validation failures both map to
 * `invalid`; they have the same meaning to consumers: the file is untrusted, so fail closed and
 * return no partial results.
 */
export function parseWorkspaceHookTrustStoreContent(
  content: string,
): WorkspaceHookTrustStoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const result = workspaceHookTrustStoreFileSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid" };
  return { status: "ok", file: result.data };
}
