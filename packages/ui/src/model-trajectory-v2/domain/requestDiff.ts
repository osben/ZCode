import type {
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2Record,
  ZCodeTrajectoryV2RequestParams,
} from "../contract.js";

export type RequestChange =
  | { kind: "param"; key: keyof ZCodeTrajectoryV2RequestParams; from?: string; to?: string }
  | { kind: "tools"; added: string[]; removed: string[] }
  | { kind: "system" }
  | { kind: "model"; from?: string; to?: string };

export interface RequestFacts {
  model?: string;
  toolCount?: number;
  toolBytes?: number;
  systemBytes?: number;
  systemBlockCount?: number;
  breakpointCount: number;
  breakpointsComplete: boolean;
}

type Interned = Pick<ZCodeModelTrajectoryV2, "toolDefs" | "toolCatalogs" | "systemPrompts">;

const PARAM_KEYS: (keyof ZCodeTrajectoryV2RequestParams)[] = [
  "maxOutputTokens",
  "thinking",
  "effort",
  "toolChoice",
  "temperature",
];

export function describeParam(
  params: ZCodeTrajectoryV2RequestParams,
  key: keyof ZCodeTrajectoryV2RequestParams,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (key === "thinking" && typeof value === "object") {
    return value.budgetTokens === undefined ? value.type : `${value.type} ${value.budgetTokens}`;
  }
  return String(value);
}

export function catalogToolNames(record: ZCodeTrajectoryV2Record, interned: Interned): string[] {
  const catalog = record.request.toolCatalogId
    ? interned.toolCatalogs[record.request.toolCatalogId]
    : undefined;
  if (!catalog) return record.request.toolNames;
  return catalog.toolDefIds.map((id) => interned.toolDefs[id]?.name ?? id);
}

export function requestFacts(record: ZCodeTrajectoryV2Record, interned: Interned): RequestFacts {
  const catalog = record.request.toolCatalogId
    ? interned.toolCatalogs[record.request.toolCatalogId]
    : undefined;
  const system = record.request.systemPromptId
    ? interned.systemPrompts[record.request.systemPromptId]
    : undefined;
  return {
    model: record.model.modelId ?? record.response?.modelId,
    toolCount: catalog ? catalog.toolDefIds.length : record.request.toolNames.length || undefined,
    toolBytes: catalog?.bytes,
    systemBytes: system?.bytes,
    systemBlockCount: system?.blockIds.length,
    breakpointCount: record.request.cacheBreakpoints.length,
    breakpointsComplete: record.request.cacheBreakpointsComplete,
  };
}

/** Changes from `previous` to `current`; an empty list when nothing changed or there is no previous request. */
export function diffRequests(
  previous: ZCodeTrajectoryV2Record | undefined,
  current: ZCodeTrajectoryV2Record,
  interned: Interned,
): RequestChange[] {
  if (!previous) return [];
  const changes: RequestChange[] = [];
  const fromModel = previous.model.modelId;
  const toModel = current.model.modelId;
  if (fromModel !== toModel) changes.push({ kind: "model", from: fromModel, to: toModel });
  for (const key of PARAM_KEYS) {
    const from = describeParam(previous.request.params, key);
    const to = describeParam(current.request.params, key);
    if (from !== to) changes.push({ kind: "param", key, from, to });
  }
  if (previous.request.toolCatalogId !== current.request.toolCatalogId) {
    const before = new Set(catalogToolNames(previous, interned));
    const after = new Set(catalogToolNames(current, interned));
    const added = [...after].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    if (added.length > 0 || removed.length > 0) changes.push({ kind: "tools", added, removed });
  }
  if (previous.request.systemPromptId !== current.request.systemPromptId) {
    changes.push({ kind: "system" });
  }
  return changes;
}

/** The nearest earlier record of the same call source kind, per record index. */
export function previousSameSource(
  records: readonly ZCodeTrajectoryV2Record[],
): (number | undefined)[] {
  const lastByKind = new Map<string, number>();
  return records.map((record, index) => {
    const kind = record.callSource?.kind ?? "main";
    const previous = lastByKind.get(kind);
    lastByKind.set(kind, index);
    return previous;
  });
}
