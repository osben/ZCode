import {
  mapModelTrajectoryRecord,
  projectModelTrajectoryInputDeltas,
  type ZCodeModelTrajectoryRecord,
} from "#src/zcode-agent/modelTrajectory.js";
import type {
  ContextWindowPort,
  ModelTrajectoryV2Ports,
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2ContextWindow,
  ZCodeTrajectoryV2Record,
} from "../contract.js";
import { createTrajectoryInterner, type TrajectoryInterner } from "../domain/dedupe.js";
import {
  extractCacheBreakpoints,
  extractRequestParams,
  parseCacheWriteTokens,
  parseStreamTiming,
} from "../domain/requestFacts.js";
import { asObject, type UnknownRecord } from "../domain/values.js";

/**
 * Build the v2 trajectory for a task: the v1 projection of the kept window, enriched with wire facts, plus interned
 * tool definitions and system blocks, tool timing and context windows. Stateless and read-only.
 */
export async function projectModelTrajectoryV2(
  taskId: string,
  limit: number,
  ports: ModelTrajectoryV2Ports,
): Promise<ZCodeModelTrajectoryV2> {
  const window = await ports.modelIo.read(taskId, limit);
  const interner = createTrajectoryInterner();
  // projectModelTrajectoryInputDeltas maps one-to-one, so index i of the projection is raw record i.
  const projected = projectModelTrajectoryInputDeltas(window.records.map(mapModelTrajectoryRecord));
  const records = projected.map((record, index) =>
    enrichRecord(record, window.records[index] ?? {}, interner),
  );

  const [toolTiming, contextWindows] = await Promise.all([
    ports.toolTiming.read(taskId, collectToolCallIds(records)),
    resolveContextWindows(records, ports.contextWindow),
  ]);
  const interned = interner.snapshot();

  return {
    taskId,
    available: true,
    truncated: window.truncated,
    sourceFiles: window.sourceFiles,
    records,
    toolDefs: interned.toolDefs,
    toolCatalogs: interned.toolCatalogs,
    systemBlocks: interned.systemBlocks,
    systemPrompts: interned.systemPrompts,
    contextWindows,
    toolTiming,
    budget: interned.budget,
  };
}

function enrichRecord(
  record: ZCodeModelTrajectoryRecord,
  raw: UnknownRecord,
  interner: TrajectoryInterner,
): ZCodeTrajectoryV2Record {
  const rawRequest = asObject(raw.request);
  const body = asObject(rawRequest?.body);
  const breakpoints = extractCacheBreakpoints(body, rawRequest?.sdkMessages);
  const toolCatalogId = interner.internToolCatalog(body?.tools);
  const systemPromptId = interner.internSystemPrompt(body?.system);
  const enriched: ZCodeTrajectoryV2Record = {
    ...record,
    request: {
      ...record.request,
      params: extractRequestParams(body),
      cacheBreakpoints: breakpoints.breakpoints,
      cacheBreakpointsComplete: breakpoints.complete,
      ...(toolCatalogId ? { toolCatalogId } : {}),
      ...(systemPromptId ? { systemPromptId } : {}),
    },
  };
  const cacheWriteTokens = parseCacheWriteTokens(asObject(raw.response)?.usage);
  if (record.response?.usage && cacheWriteTokens !== undefined) {
    enriched.response = {
      ...record.response,
      usage: { ...record.response.usage, cacheWriteTokens },
    };
  }
  const timing = parseStreamTiming(raw.timing);
  if (timing) enriched.timing = timing;
  return enriched;
}

/** Tool call ids answered in the window and those still visible in input history. */
function collectToolCallIds(records: readonly ZCodeTrajectoryV2Record[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    for (const part of record.response?.toolCalls ?? []) {
      if (part.kind === "tool-call" && part.toolCallId) ids.add(part.toolCallId);
    }
    for (const message of record.request.messages) {
      for (const part of message.parts) {
        if (part.kind === "tool-call" && part.toolCallId) ids.add(part.toolCallId);
      }
    }
  }
  return [...ids];
}

async function resolveContextWindows(
  records: readonly ZCodeTrajectoryV2Record[],
  resolve: ContextWindowPort | undefined,
): Promise<ZCodeTrajectoryV2ContextWindow[]> {
  const models = new Map<string, { providerId: string; modelId: string }>();
  for (const record of records) {
    const { providerId, modelId } = record.model;
    if (providerId && modelId) models.set(`${providerId}\u0000${modelId}`, { providerId, modelId });
  }
  return Promise.all(
    [...models.values()].map(async (model) => {
      let tokens: number | undefined;
      try {
        tokens = await resolve?.(model);
      } catch {
        tokens = undefined;
      }
      return typeof tokens === "number" && tokens > 0 ? { ...model, tokens } : { ...model };
    }),
  );
}
