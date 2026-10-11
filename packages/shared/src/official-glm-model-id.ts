// Use only for the official model list, telemetry allowlist, and one-way migration entry point; not for Registry comparisons or general request rewriting.
const canonicalIds = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5V-Turbo",
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5.1-Highspeed",
  "GLM-5",
  "GLM-5-Turbo",
  "GLM-4.7",
  "GLM-4.7-FlashX",
  "GLM-4.7-Flash",
  "GLM-4.6",
  "GLM-4.5-Air",
  "GLM-4.5",
  "GLM-4.6V",
  "GLM-4.6V-Flash",
  "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash",
  "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414",
  "GLM-4V-Flash",
];
const byLowercase = new Map(canonicalIds.map((id) => [id.toLowerCase(), id]));

/** Canonical IDs for official GLM models; the telemetry allowlist is derived from this list, so add new official models here as well. */
export const OFFICIAL_GLM_MODEL_IDS: readonly string[] = canonicalIds;

export function normalizeOfficialGlmModelId(modelId: string): string {
  return byLowercase.get(modelId.toLowerCase()) ?? modelId;
}
