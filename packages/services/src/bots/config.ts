import {
  DEFAULT_BOT_COMMANDS,
  DEFAULT_BOT_REPLY_GRANULARITY,
  modelSelectionSchema,
  normalizeBotReplyGranularity,
  type BotCurrentOptions,
  type BotDraftOptions,
  type BotCommandPolicy,
  type BotsConfigFile,
  type BotProvider,
} from "@zcode/shared";
export { BOT_BIND_CODE_TTL_MS } from "@zcode/shared";

// Rollback compatibility: older Apps parse Options strictly; old files are only pre-upgrade snapshots and must not be written back continuously.
export const BOTS_CONFIG_FILE = "bot-config.v3.json";
export const BOTS_LEGACY_CONFIG_FILE = "bot-config.json";
export const BOTS_LEGACY_STATE_FILE = "bot-state.json";
export const BOTS_V2_STATE_FILE = "bot-state.v2.json";
export const BOTS_STATE_FILE = "bot-state.v3.json";
/** Pre-migration copies written once before the `[hostId, projectId]` identity rewrite; restore these to downgrade. */
export const BOTS_CONFIG_PRE_PROJECT_IDENTITY_FILE = "bot-config.v3.pre-project-identity.json";
export const BOTS_STATE_PRE_PROJECT_IDENTITY_FILE = "bot-state.v3.pre-project-identity.json";
export const BOTS_LEGACY_MODEL_CACHE_FILE = "bots-model-cache.json";
export const BOTS_MODEL_CACHE_FILE = "bots-model-cache.v2.json";
const BOT_CREDENTIAL_PREFIX = "bot";

export function createDefaultBotsConfig(): BotsConfigFile {
  return {
    version: 3,
    bots: [],
  };
}

export function createDefaultBotCommands(): BotCommandPolicy {
  return { ...DEFAULT_BOT_COMMANDS };
}

export function normalizeBotCommandPolicy(
  commands: Partial<BotCommandPolicy> & { cli?: unknown } = {},
): BotCommandPolicy {
  // Bug fix: the /cli command has been removed; a leftover cli field in historical bot-config.json must not be saved into new configuration.
  return {
    ...DEFAULT_BOT_COMMANDS,
    status: commands.status ?? DEFAULT_BOT_COMMANDS.status,
    new: commands.new ?? DEFAULT_BOT_COMMANDS.new,
    workspace: commands.workspace ?? DEFAULT_BOT_COMMANDS.workspace,
    model: commands.model ?? DEFAULT_BOT_COMMANDS.model,
    mode: commands.mode ?? DEFAULT_BOT_COMMANDS.mode,
    thoughtLevel: commands.thoughtLevel ?? DEFAULT_BOT_COMMANDS.thoughtLevel,
    sandboxMode: commands.sandboxMode ?? DEFAULT_BOT_COMMANDS.sandboxMode,
    approvalPolicy: commands.approvalPolicy ?? DEFAULT_BOT_COMMANDS.approvalPolicy,
    remote: commands.remote ?? DEFAULT_BOT_COMMANDS.remote,
    reply: commands.reply ?? DEFAULT_BOT_COMMANDS.reply,
  };
}

export function normalizeBotCurrentOptions(
  options: Partial<BotCurrentOptions> & {
    cli?: unknown;
    model?: unknown;
    thoughtLevel?: unknown;
  } = {},
): BotCurrentOptions {
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  // Read the old model/thoughtLevel only during the Repository's one-time import; ordinary saves use only the new fields.
  // Bug fix: after /cli was removed, historical currentOptions.cli is read only for legacy compatibility and is no longer saved.
  return {
    ...(modelSelection ? { modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
  };
}

export function normalizeBotDraftOptions(options: BotDraftOptions): BotDraftOptions {
  const parsedSelection = modelSelectionSchema.safeParse(options.modelSelection);
  const modelSelection = parsedSelection.success ? parsedSelection.data : undefined;
  return {
    provider: options.provider,
    ...(modelSelection ? { modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
}

export function getDefaultBotReplyGranularity(provider?: BotProvider) {
  return provider
    ? normalizeBotReplyGranularity(provider, undefined)
    : DEFAULT_BOT_REPLY_GRANULARITY;
}

export function buildBotCredentialKey(botId: string): string {
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:credential`;
}

export function buildBotWebhookSecretKey(botId: string): string {
  return `${BOT_CREDENTIAL_PREFIX}:${botId}:webhook-secret`;
}
