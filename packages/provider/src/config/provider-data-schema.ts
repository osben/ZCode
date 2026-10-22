import { z } from "zod";
import {
  ACP_ENV_KEY_PATTERN,
  describeAcpArgsProblem,
  describeAcpCommandProblem,
  describeAcpEnvProblem,
} from "@zcode/shared/acp-launch-rules";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
  // ChatGPT plan (official OpenAI SIWC); an account family independent of zai/bigmodel.
  "chatgpt-family",
]);
export const zhipuAccountModeDataSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  // Highspeed-card access category; mirrors zcodeProviderAccountAccessSchema.mode — change
  // both together.
  "highspeed",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

export const apiKeyAccessDataSchema = z
  .object({
    type: z.enum(["api-key", "zhipu-coding-plan-api-key"]),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
  })
  .strict();
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.extend({
  apiKey: nonBlankRequiredString,
});

export const completeZhipuAccountAccessDataSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: zhipuAccountModeDataSchema,
    entitled: z.boolean(),
  })
  .strict();
export const zhipuAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeZhipuAccountAccessDataSchema.shape),
    type: completeZhipuAccountAccessDataSchema.shape.type,
  })
  .strict();
/**
 * ChatGPT plan account (official OpenAI SIWC token sharing). Deliberately separate from
 * zhipu-account so it never triggers zcode gateway routing or zhipu-specific handling.
 */
export const completeChatgptAccountAccessDataSchema = z
  .object({
    type: z.literal("chatgpt-account"),
    entitled: z.boolean(),
  })
  .strict();
export const chatgptAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeChatgptAccountAccessDataSchema.shape),
    type: completeChatgptAccountAccessDataSchema.shape.type,
  })
  .strict();
/**
 * External ACP agent provider access: a local agent process (opencode,
 * cursor-agent, …) driven over JSON-RPC stdio instead of an HTTP endpoint.
 * Providers with this access do not require an `api` section.
 */
const acpAgentEnvKeySchema = z.string().regex(ACP_ENV_KEY_PATTERN);
/** Structural shape shared by the stored (sparse) and complete schemas. */
const acpAgentAccessStructuralShape = {
  type: z.literal("acp-agent"),
  agentId: z.string().min(1),
  command: nonBlankRequiredString,
  args: z.array(z.string()).readonly(),
  env: z.record(acpAgentEnvKeySchema, z.string()).readonly().nullable().optional(),
};
/** Adds a shared launch-rule refinement (`@zcode/shared/acp-launch-rules`) to a field schema. */
function withAcpLaunchRule<T extends z.ZodType>(
  schema: T,
  describe: (value: z.output<T>) => string | null,
) {
  return schema.superRefine((value, ctx) => {
    const problem = describe(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
}
// The complete shape enforces the launch rules per field (so every consumer of the field
// schema inherits them); the stored sparse shape stays structural so one invalid entry is
// reported by complete validation instead of failing the whole personal provider file.
export const completeAcpAgentAccessDataSchema = z
  .object({
    ...acpAgentAccessStructuralShape,
    command: withAcpLaunchRule(acpAgentAccessStructuralShape.command, describeAcpCommandProblem),
    args: withAcpLaunchRule(acpAgentAccessStructuralShape.args, describeAcpArgsProblem),
    env: withAcpLaunchRule(acpAgentAccessStructuralShape.env, describeAcpEnvProblem),
  })
  .strict();
export const acpAgentAccessDataSchema = z
  .object({
    ...sparseShape(acpAgentAccessStructuralShape),
    type: acpAgentAccessStructuralShape.type,
  })
  .strict();
export const providerAccessDataSchema = z.discriminatedUnion("type", [
  apiKeyAccessDataSchema,
  zhipuAccountAccessDataSchema,
  chatgptAccountAccessDataSchema,
  acpAgentAccessDataSchema,
]);
// Registry-complete access deliberately excludes ACP: `serializeRegistryProviderAccess`
// treats every non-account access as API-key, so a complete ACP config must never pass
// this union. ACP validation uses `completeAcpProviderConfigDataSchema` below.
export const completeProviderAccessDataSchema = z.discriminatedUnion("type", [
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeChatgptAccountAccessDataSchema,
]);

export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: nonBlankRequiredString.pipe(z.string().url()),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict();
export const providerApiDataSchema = z
  .object({
    ...sparseShape(completeProviderApiDataSchema.shape),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();
// Personal may temporarily store an endpoint while it is being edited; the full schema still rejects it, and admission is affected only for that Provider.
export const personalProviderApiDataSchema = providerApiDataSchema.extend({
  baseUrl: z.string().nullable().optional(),
});

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
export const providerConfigDataSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const completeProviderConfigDataSchema = providerConfigDataSchema.extend({
  group: providerGroupDataSchema,
  access: completeProviderAccessDataSchema,
  api: completeProviderApiDataSchema,
});

/**
 * Complete Personal-provider shape for ACP agents: the registry-complete schema
 * minus the HTTP `api` section (agents have no endpoint) and with the complete
 * ACP access. Used for Settings validation only — Registry entries stay
 * API-key/account-only.
 */
export const completeAcpProviderConfigDataSchema = completeProviderConfigDataSchema
  .omit({ api: true })
  .extend({ access: completeAcpAgentAccessDataSchema });

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    config: providerConfigDataSchema,
  })
  .strict();
