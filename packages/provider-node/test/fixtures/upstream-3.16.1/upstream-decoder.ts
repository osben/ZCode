/**
 * Upstream 3.16.1 (commit 0a1fc56d279fd1001f78387bd81aec1c26767411, pinned in
 * fork-upstream-base.json) schema gate of `decodeProviderConfigFile`.
 *
 * The sibling schema files are verbatim `git show <pin>:<path>` copies with only their import
 * specifiers rewritten to relative paths. Re-copy them on every upstream sync that bumps the pin.
 * This module reproduces upstream's stored-file envelope plus the two rule parses that decide
 * whether an upstream build accepts `provider_config.json`.
 */
import { z } from "zod";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import {
  personalModelConfigRulesSchema,
  personalProviderConfigRulesSchema,
} from "./rule-data-schema.js";

const upstreamStoredProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
        defaultModelSelection: modelSelectionSchema.optional(),
      })
      .strict(),
  })
  .strict();

/** Throws exactly where upstream's decoder throws (which upstream then treats as an invalid file). */
export function decodeWithUpstreamSchemas(input: unknown): void {
  const parsed = upstreamStoredProviderConfigSchema.parse(input);
  personalProviderConfigRulesSchema.parse(parsed.config.providerConfigRules);
  personalModelConfigRulesSchema.parse(parsed.config.modelConfigRules);
}
