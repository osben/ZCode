import type {
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryTruncation,
  ZCodeModelTrajectoryUsage,
} from "#src/zcode-agent/modelTrajectory.js";

export type { ZCodeModelTrajectoryTruncation };

/** Interned ids are stable only within one response. */
export type TrajectoryToolDefId = string;
export type TrajectoryCatalogId = string;
export type TrajectorySystemBlockId = string;
export type TrajectorySystemPromptId = string;

/** Mirrors the model-io `timing` key (specs/model-io-stream-timing.md); ms from the record's `startedAt`. */
export interface ZCodeTrajectoryV2StreamTiming {
  stream: boolean;
  timeToFirstProviderEventMs?: number;
  /** The trajectory TTFT: first text, reasoning or tool-input event. */
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
}

export interface ZCodeTrajectoryV2RequestParams {
  maxOutputTokens?: number;
  thinking?: { type: string; budgetTokens?: number };
  effort?: string;
  /** "auto" | "any" | "none" | "required" | "tool:<name>". */
  toolChoice?: string;
  temperature?: number;
  stream?: boolean;
}

export interface ZCodeTrajectoryV2CacheBreakpoint {
  location: "system" | "tools" | "message";
  /** Block, tool or message index on the wire. */
  index: number;
  ttl?: string;
}

export interface ZCodeTrajectoryV2Usage extends ZCodeModelTrajectoryUsage {
  cacheWriteTokens?: number;
}

type V1Request = ZCodeModelTrajectoryRecord["request"];
type V1Response = NonNullable<ZCodeModelTrajectoryRecord["response"]>;

export interface ZCodeTrajectoryV2Request extends V1Request {
  params: ZCodeTrajectoryV2RequestParams;
  /** Absent when the wire body has no tools; the UI falls back to `toolNames`. */
  toolCatalogId?: TrajectoryCatalogId;
  /** Absent when the wire body has no system blocks; the UI falls back to system-role input. */
  systemPromptId?: TrajectorySystemPromptId;
  cacheBreakpoints: ZCodeTrajectoryV2CacheBreakpoint[];
  /** False when message-level markers could not be read (message bodies trimmed). */
  cacheBreakpointsComplete: boolean;
}

export interface ZCodeTrajectoryV2Response extends V1Response {
  usage?: ZCodeTrajectoryV2Usage;
}

/** A v1 record with wire facts; assignable to the v1 record so v1 helpers stay reusable. */
export interface ZCodeTrajectoryV2Record extends ZCodeModelTrajectoryRecord {
  request: ZCodeTrajectoryV2Request;
  response?: ZCodeTrajectoryV2Response;
  /** Absent on records written before the timing field existed. */
  timing?: ZCodeTrajectoryV2StreamTiming;
}

export interface ZCodeTrajectoryV2ToolDef {
  name: string;
  description?: string;
  /** Parsed schema, or its bounded JSON string when `truncated` is set. */
  inputSchema?: unknown;
  bytes: number;
  truncated?: ZCodeModelTrajectoryTruncation;
  /** Past the total budget: only name and size are kept. */
  omitted?: boolean;
}

export interface ZCodeTrajectoryV2ToolCatalog {
  toolDefIds: TrajectoryToolDefId[];
  bytes: number;
}

export interface ZCodeTrajectoryV2SystemBlock {
  text: string;
  bytes: number;
  truncated?: ZCodeModelTrajectoryTruncation;
  omitted?: boolean;
}

export interface ZCodeTrajectoryV2SystemPrompt {
  blockIds: TrajectorySystemBlockId[];
  bytes: number;
}

export type ZCodeTrajectoryV2ToolStatus = "running" | "completed" | "error" | "cancelled";

/** Epoch ms. Execution times are absent when the CLI recorded no duration or interval. */
export interface ZCodeTrajectoryV2ToolTiming {
  toolCallId: string;
  toolName: string;
  status: ZCodeTrajectoryV2ToolStatus;
  approvalStatus?: string;
  turnId?: string;
  /** Includes permission wait. */
  scheduledAt: number;
  execStartedAt?: number;
  execEndedAt?: number;
  execDurationMs?: number;
  errorType?: string;
}

export type ZCodeTrajectoryV2ToolTimingUnavailableReason =
  | "db-path-unknown"
  | "db-missing"
  | "read-failed";

export type ZCodeTrajectoryV2ToolTimingResult =
  | { source: "session-db"; entries: ZCodeTrajectoryV2ToolTiming[] }
  | {
      source: "unavailable";
      reason: ZCodeTrajectoryV2ToolTimingUnavailableReason;
      entries: [];
    };

export interface ZCodeTrajectoryV2ContextWindow {
  providerId: string;
  modelId: string;
  /** Absent when the provider registry does not know the model. */
  tokens?: number;
}

export interface ZCodeTrajectoryV2Budget {
  toolDefBytes: number;
  systemBytes: number;
  omitted: boolean;
}

export interface ZCodeModelTrajectoryV2 {
  taskId: string;
  available: boolean;
  truncated: boolean;
  sourceFiles: string[];
  records: ZCodeTrajectoryV2Record[];
  toolDefs: Record<TrajectoryToolDefId, ZCodeTrajectoryV2ToolDef>;
  toolCatalogs: Record<TrajectoryCatalogId, ZCodeTrajectoryV2ToolCatalog>;
  systemBlocks: Record<TrajectorySystemBlockId, ZCodeTrajectoryV2SystemBlock>;
  systemPrompts: Record<TrajectorySystemPromptId, ZCodeTrajectoryV2SystemPrompt>;
  contextWindows: ZCodeTrajectoryV2ContextWindow[];
  toolTiming: ZCodeTrajectoryV2ToolTimingResult;
  budget: ZCodeTrajectoryV2Budget;
}

/** Kept raw model-io records after writer-delta expansion, oldest first. */
export interface TrajectoryV2RawWindow {
  records: Record<string, unknown>[];
  sourceFiles: string[];
  truncated: boolean;
}

export interface ModelIoWindowPort {
  read(taskId: string, limit: number): Promise<TrajectoryV2RawWindow>;
}

export interface ToolTimingPort {
  read(taskId: string, toolCallIds: readonly string[]): Promise<ZCodeTrajectoryV2ToolTimingResult>;
}

/** Resolves a model's context window; undefined or a throw means unknown. */
export type ContextWindowPort = (input: {
  providerId: string;
  modelId: string;
}) => Promise<number | undefined>;

export interface ModelTrajectoryV2Ports {
  modelIo: ModelIoWindowPort;
  toolTiming: ToolTimingPort;
  contextWindow?: ContextWindowPort;
}
