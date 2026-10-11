/**
 * runner-status.ts reached oxlint's max-lines limit (400), so the request attribution header group
 * (header constants, internal-prefix stripping, and session-type inference) was split into this file.
 * The public API is still exported from runner-status.ts.
 *
 * Dependency direction with runner-status.ts: this file only `import type`s its ModelStatusContext,
 * so there is no runtime cycle.
 */

import type {
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  ResolvedModelApiCallObservation,
} from "@zcode/contracts";
import { ModelApiActorKind, ModelApiOperation, ModelRequestSessionType } from "@zcode/contracts";
import { isOpenCodeGoBaseUrl } from "./opencode-session.js";
import { MODEL_QUERY_SOURCE_HEADER } from "./model-request-headers.js";
import type { ModelStatusContext } from "./runner-status.js";

const MODEL_TRACE_HEADER = "x-zcode-trace-id";
const MODEL_REQUEST_HEADER = "x-request-id";
const MODEL_SESSION_HEADER = "x-session-id";
const MODEL_QUERY_HEADER = "x-query-id";
// The Coding Plan server uses this request-level header to distinguish main/subagent/side_chat/other sources.
// It is neither a static Provider capability nor authentication material; generate it from the call context and override any static header with the same name.
const MODEL_SESSION_TYPE_HEADER = "x-zcode-session-type";
const SESSION_ID_INTERNAL_PREFIX = "sess_";
const SESSION_ID_SUBAGENT_PREFIX = "subagent_agent_";
const QUERY_ID_INTERNAL_PREFIX = "query_";
const QUERY_SOURCE_HEADER_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

export function createModelRequestAttributionHeaders(
  statusContext: ModelStatusContext,
): Record<string, string> {
  const sessionHeaderValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const queryHeaderValue = modelQueryHeaderValue(statusContext.queryId);
  const querySource = statusContext.querySource?.trim();
  // querySource is an observability label; omit invalid or oversized values so HTTP header validation cannot block the model request.
  const querySourceHeaderValue =
    querySource && QUERY_SOURCE_HEADER_VALUE_PATTERN.test(querySource) ? querySource : undefined;
  const openCodeSessionHeaderValue = isOpenCodeGoBaseUrl(statusContext.baseURL)
    ? sessionHeaderValue
    : undefined;
  // Put only attribution fields needed across the provider network boundary in the header;
  // keep finer-grained data such as spans in events and logs.
  return {
    [MODEL_REQUEST_HEADER]: statusContext.requestId,
    [MODEL_SESSION_TYPE_HEADER]: isModelRequestSessionType(statusContext.modelRequestSessionType)
      ? statusContext.modelRequestSessionType
      : ModelRequestSessionType.Other,
    [MODEL_TRACE_HEADER]: statusContext.traceId,
    ...(queryHeaderValue ? { [MODEL_QUERY_HEADER]: queryHeaderValue } : {}),
    ...(querySourceHeaderValue ? { [MODEL_QUERY_SOURCE_HEADER]: querySourceHeaderValue } : {}),
    ...(sessionHeaderValue ? { [MODEL_SESSION_HEADER]: sessionHeaderValue } : {}),
    ...(openCodeSessionHeaderValue ? { "x-opencode-session": openCodeSessionHeaderValue } : {}),
  };
}

export function resolveModelRequestSessionType(
  explicitType: unknown,
  modelCall: Pick<ResolvedModelApiCallObservation, "actorKind" | "operation">,
): ModelRequestSessionTypeValue {
  if (isModelRequestSessionType(explicitType)) return explicitType;
  if (modelCall.operation !== ModelApiOperation.AgentStep) {
    return ModelRequestSessionType.Other;
  }
  if (modelCall.actorKind === ModelApiActorKind.MainAgent) {
    return ModelRequestSessionType.Main;
  }
  if (modelCall.actorKind === ModelApiActorKind.Subagent) {
    return ModelRequestSessionType.Subagent;
  }
  return ModelRequestSessionType.Other;
}

function isModelRequestSessionType(value: unknown): value is ModelRequestSessionTypeValue {
  return (
    value === ModelRequestSessionType.Main ||
    value === ModelRequestSessionType.Subagent ||
    value === ModelRequestSessionType.SideChat ||
    value === ModelRequestSessionType.Other
  );
}

export function normalizeModelSessionIdForAttribution(
  sessionId: ModelStatusContext["sessionId"],
): string | undefined {
  if (!sessionId) return undefined;
  // Internal SessionId/QueryId prefixes are only for CLI storage and event attribution. A provider
  // header is an observational field sent across the network, so do not expose implementation
  // prefixes such as query_/subagent_agent_ upstream.
  return stripHeaderInternalPrefixes(sessionId, [
    SESSION_ID_INTERNAL_PREFIX,
    SESSION_ID_SUBAGENT_PREFIX,
  ]);
}

function modelQueryHeaderValue(queryId: ModelStatusContext["queryId"]): string | undefined {
  if (!queryId) return undefined;
  return stripHeaderInternalPrefixes(queryId, [QUERY_ID_INTERNAL_PREFIX]);
}

function stripHeaderInternalPrefixes(value: string, prefixes: string[]): string {
  let headerValue = value;
  for (const prefix of prefixes) {
    if (headerValue.startsWith(prefix) && headerValue.length > prefix.length) {
      headerValue = headerValue.slice(prefix.length);
    }
  }
  return headerValue || value;
}
