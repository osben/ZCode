import type {
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
} from "../../src/session/zcodeTaskService.js";

/**
 * Reference for the input-delta contract: each record's full input, with deltas chained onto the nearest
 * preceding record that has the same requestId. Throws when a delta base is missing or its length differs.
 */
export function expandTrajectoryInputs(
  records: readonly ZCodeModelTrajectoryRecord[],
): ZCodeModelTrajectoryMessage[][] {
  const inputs = new Map<string, ZCodeModelTrajectoryMessage[]>();
  return records.map((record) => {
    const delta = record.inputDeltaOf;
    if (!delta) {
      const full = [...record.request.messages];
      inputs.set(record.requestId, full);
      return full;
    }
    const base = inputs.get(delta.previousRequestId);
    if (!base || base.length !== delta.sharedPrefixCount) {
      throw new Error(`delta base ${delta.previousRequestId} is missing for ${record.requestId}`);
    }
    const full = [...base, ...record.request.messages];
    inputs.set(record.requestId, full);
    return full;
  });
}
