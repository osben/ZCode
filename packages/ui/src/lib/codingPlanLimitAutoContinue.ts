import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

const CODING_PLAN_PROVIDER_IDS = new Set<string>([
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
]);

/** Parse the reset timestamp from the supported five-hour Coding Plan error text. */
export function parseCodingPlanLimitResetAt(
  providerId: string | null,
  businessCode: string | null,
  message: string | null | undefined,
): number | null {
  if (
    !providerId ||
    !CODING_PLAN_PROVIDER_IDS.has(providerId) ||
    businessCode !== "1308" ||
    !message
  ) {
    return null;
  }

  const match = message.match(
    /Usage limit reached for 5 hours?\.\s+Your limit will reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/iu,
  );
  if (!match?.[1] || !match[2]) return null;

  // The error has no timezone; the user's PST/resetAt comparison points to UTC+08:00. Apply the offset explicitly so Date.parse does not use the device's local timezone.
  const resetAt = Date.parse(`${match[1]}T${match[2]}+08:00`);
  if (!Number.isFinite(resetAt)) return null;
  const timestampAtUtc = new Date(resetAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return timestampAtUtc === `${match[1]}T${match[2]}` ? resetAt : null;
}

/** Pick a 1–3 minute grace period after reset, starting from now if reset time has passed. */
export function codingPlanAutoContinueDelayMs(
  resetAt: number,
  now: number,
  random: number,
): number {
  const waitUntilReset = Math.max(0, resetAt - now);
  const gracePeriod = 60_000 + Math.floor(Math.max(0, Math.min(0.999999, random)) * 120_000);
  return waitUntilReset + gracePeriod;
}
