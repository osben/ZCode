interface CallSourceCarrier {
  callSource?: { kind: string; querySource?: string };
}

/**
 * A subagent session writes its own loop to its own model-io file as querySource "subagent"; parents
 * never carry those calls. A window with no main call but with subagent calls is therefore a subagent
 * session's trajectory, and its subagent calls are its main calls (specs/model-trajectory-v2.md 3a).
 */
export function promoteSubagentSessionLoop<T extends CallSourceCarrier>(records: T[]): T[] {
  const kinds = new Set(records.map((record) => record.callSource?.kind));
  if (kinds.has("main") || !kinds.has("subagent")) {
    return records;
  }
  return records.map((record) =>
    record.callSource?.kind === "subagent"
      ? { ...record, callSource: { ...record.callSource, kind: "main" } }
      : record,
  );
}
