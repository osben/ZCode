import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

export function normalizeQuotaModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^model:/u, "")
    .replace(/_/gu, "-");
}

export function bucketMatchesModel(bucket: UsageQuotaLimit, modelId: string): boolean {
  return bucket.usageDetails.some(
    (detail) => normalizeQuotaModel(detail.modelCode) === normalizeQuotaModel(modelId),
  );
}

export function getActiveModelBuckets(
  snapshot: UsageEntitlementSnapshot,
  now = snapshot.serverTime ?? snapshot.generatedAt,
): UsageQuotaLimit[] {
  return (snapshot.quota?.limits ?? []).filter(
    (bucket) =>
      (!bucket.meter || bucket.meter === "model_usage") &&
      (bucket.nextResetTime === undefined || bucket.nextResetTime > now) &&
      (bucket.periodStart === undefined || bucket.periodStart <= now) &&
      (bucket.periodEnd === undefined || bucket.periodEnd > now),
  );
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function bucketRemainingRatio(bucket: UsageQuotaLimit): number | null {
  // Use the actual remaining quota in the same bucket; do not treat available (after reservations) as remaining.
  if (finite(bucket.remaining) && finite(bucket.number) && bucket.number > 0) {
    return bucket.remaining / bucket.number;
  }
  return finite(bucket.percentage) ? bucket.percentage : null;
}

export function allBucketsExhausted(buckets: UsageQuotaLimit[]): boolean {
  // Looking only at the first bucket would report the model exhausted when the active bucket is empty but the daily bucket still has quota; unknown values are not zero.
  return (
    buckets.length > 0 &&
    buckets.every((bucket) =>
      finite(bucket.remaining) ? bucket.remaining <= 0 : bucketRemainingRatio(bucket) === 0,
    )
  );
}

export function bucketReminderKey(bucket: UsageQuotaLimit): string | null {
  if (
    !bucket.bucketId?.trim() ||
    !finite(bucket.periodStart) ||
    !finite(bucket.periodEnd) ||
    bucket.periodStart < 0 ||
    bucket.periodEnd <= bucket.periodStart
  )
    return null;
  // Bucket identity isolates accounts/plans; when one bucket serves multiple models, notify only once and do not put tasks or balances in the key.
  return JSON.stringify([bucket.bucketId.trim(), bucket.periodStart, bucket.periodEnd]);
}
