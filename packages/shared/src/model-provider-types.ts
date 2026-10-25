/* eslint-disable max-lines -- Keep model-provider schemas, migrations, and runtime projection helpers in one file so they share a single type boundary and the contract stays together. */
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

export const BUILTIN_MODEL_PROVIDER_IDS = {
  zaiIndividualCodingPlan: "account:zai-individual-coding-plan",
  zaiTeamCodingPlan: "account:zai-team-coding-plan",
  zaiStartPlan: "account:zai-start-plan",
  bigmodelIndividualCodingPlan: "account:bigmodel-individual-coding-plan",
  bigmodelTeamCodingPlan: "account:bigmodel-team-coding-plan",
  bigmodelStartPlan: "account:bigmodel-start-plan",
  chatgptPlan: "account:chatgpt-plan",
} as const;

export type BuiltinOAuthProviderId = keyof typeof BUILTIN_MODEL_PROVIDER_IDS;

export type BuiltinModelProviderId = (typeof BUILTIN_MODEL_PROVIDER_IDS)[BuiltinOAuthProviderId];

export function isBuiltinModelProviderId(id: string): id is BuiltinModelProviderId {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan
  );
}

/**
 * Prefix of runtime-derived per-account ChatGPT plan provider ids
 * (`account:chatgpt-plan:<accountKey>`). The base builtin id stays in the catalog
 * only as the template rule; the registry publishes per-account entries.
 */
export const CHATGPT_PLAN_ACCOUNT_PROVIDER_ID_PREFIX =
  `${BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan}:` as const;

/** accountKey segment: 16 lowercase hex chars (sha256(sub) prefix — no PII in ids or logs). */
export function isChatGptPlanAccountKey(accountKey: string): boolean {
  return /^[a-f0-9]{16}$/.test(accountKey.trim());
}

/** Runtime provider id of one signed-in ChatGPT plan account. */
export function buildChatGptPlanAccountProviderId(accountKey: string): string {
  const normalized = accountKey.trim();
  if (!isChatGptPlanAccountKey(normalized)) {
    throw new Error(`Invalid ChatGPT plan account key: ${normalized}`);
  }
  return `${CHATGPT_PLAN_ACCOUNT_PROVIDER_ID_PREFIX}${normalized}`;
}

/** Parse a per-account ChatGPT plan provider id back to its account key; null for any other id. */
export function parseChatGptPlanAccountProviderId(providerId: string): string | null {
  const normalized = providerId.trim();
  if (!normalized.startsWith(CHATGPT_PLAN_ACCOUNT_PROVIDER_ID_PREFIX)) return null;
  const accountKey = normalized.slice(CHATGPT_PLAN_ACCOUNT_PROVIDER_ID_PREFIX.length);
  return isChatGptPlanAccountKey(accountKey) ? accountKey : null;
}

/** Whether the id is a runtime per-account ChatGPT plan provider entry. */
export function isChatGptPlanAccountProviderId(providerId: string): boolean {
  return parseChatGptPlanAccountProviderId(providerId) !== null;
}

/** Whether the id belongs to the ChatGPT plan provider (base template id or a per-account entry). */
export function isChatGptPlanProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan ||
    isChatGptPlanAccountProviderId(providerId)
  );
}

export function isZaiCodingPlanProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  );
}

export function isBigModelStartPlanProviderId(id: string): boolean {
  return id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
}

export function isStartPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/**
 * Individual Coding Plan (excluding Start Plan and Team Plan).
 * Start Plan uses disconnected to show the claim/purchase card, and Team Plan has separate copy;
 * only the individual plan needs to distinguish an explicit server response of "no entitlement" as "not subscribed."
 */
export function isIndividualCodingPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  );
}

export function isCodingPlanModelProviderId(id: string): boolean {
  return (
    isZaiCodingPlanProviderId(id) ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/** Connectivity test result for a registered Model. */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** Eligibility failure confirmed at the connection-test boundary; preserve the original message for other execution errors. */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };
