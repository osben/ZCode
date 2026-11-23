/**
 * The trust store file schema has moved to `@zcode/shared/workspace-hook-trust-store-file`
 * as the single authoritative implementation. The services layer cannot depend on contracts
 * under apps, so it previously had to implement partial validation, causing the UI and runtime
 * to disagree about the same corrupted file.
 *
 * Re-export here to preserve existing contracts import paths (adapters/bootstrap/core, etc.).
 * Contracts and shared use the same zod 4, so schemas inside contracts can compose these schemas directly.
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@zcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
