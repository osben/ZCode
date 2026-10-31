import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
  // User-triggered retry after the latest failure of the "Model providers" category on the data-sync page; emitted only by the Main coordinator.
  "user-retry",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Credential categories allowed to move across Environments during Provisioning. */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** Only for validating legacy schema v1 envelopes; new Sources do not export and new Targets do not apply these historical Keys. */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/** Envelope for Personal Config; @zcode/provider validates the specific fields again in the target Environment. */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    // In v2, a missing account Key no longer means deletion; old Targets must reject the envelope before any write.
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      value.schemaVersion === 1 ||
      value.credentials.every((entry) => entry.scope === "oauth-session"),
    { message: "Provisioning v2 only accepts OAuth credentials", path: ["credentials"] },
  );

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

/** Only fixed phase codes cross processes; remote free text must not become publicly visible diagnostic information. */
export const providerProvisioningErrorCodeSchema = z.enum([
  "source-read-failed",
  "target-call-failed",
  "target-write-failed",
  "target-refresh-failed",
  "target-commit-failed",
  "target-apply-failed",
  "capability-unavailable",
  "session-unavailable",
  "host-execution-failed",
]);
export type ProviderProvisioningErrorCode = z.infer<typeof providerProvisioningErrorCodeSchema>;

/** Trigger sources by which the Host notifies Main after saving a local Source; first online and user retry are produced only by the Main coordinator itself. */
export type ProviderProvisioningSourceTrigger = Exclude<
  ProviderProvisioningTrigger,
  "environment-online" | "user-retry"
>;

/**
 * The Main coordinator's in-memory record of the latest execution result per lane (Environment key), queried by sourceServerId.
 * It flows only between local Main → Host → Renderer; it is not persisted and does not enter remote workspace RPC contracts or the mobile whitelist.
 * - `none`: no registered lane on that device (no project from that device open locally); nothing to push and nothing to retry.
 * - `present`: a lane exists; `running` tells whether a drain is executing; `lastResult` contains only time, outcome, and a fixed stage code — never a Secret.
 */
export const providerProvisioningLaneStatusSchema = z.discriminatedUnion("lane", [
  z.object({ lane: z.literal("none") }).strict(),
  z
    .object({
      lane: z.literal("present"),
      running: z.boolean(),
      lastResult: z
        .object({
          at: z.number().int().nonnegative(),
          outcome: z.enum(["success", "failed"]),
          errorCode: providerProvisioningErrorCodeSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ProviderProvisioningLaneStatus = z.infer<typeof providerProvisioningLaneStatusSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;
