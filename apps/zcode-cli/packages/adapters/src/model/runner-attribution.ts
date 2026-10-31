/**
 * runner-status.ts hit the oxlint max-lines cap (400 lines), so the "request attribution header" family
 * (header constants, internal prefix stripping, session-type inference, session feature tags) was split into this file; the public surface is still exported from runner-status.ts.
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
import {
  MODEL_QUERY_SOURCE_HEADER,
  MODEL_SESSION_FEATURES_HEADER,
} from "./model-request-headers.js";
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
// Session feature tag format and limits (docs/design/v2/model/session-features-header.md, "Header format").
const SESSION_FEATURE_VALUE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const SESSION_FEATURES_HEADER_MAX_LENGTH = 256;
const SESSION_FEATURES_SEPARATOR = ",";

export function createModelRequestAttributionHeaders(
  statusContext: ModelStatusContext,
): Record<string, string> {
  const sessionHeaderValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const queryHeaderValue = modelQueryHeaderValue(statusContext.queryId);
  const querySource = statusContext.querySource?.trim();
  // querySource is an observability label; omit invalid or oversized values so HTTP header validation cannot block the model request.
  const querySourceHeaderValue =
    querySource && QUERY_SOURCE_HEADER_VALUE_PATTERN.test(querySource) ? querySource : undefined;
  const sessionFeaturesHeaderValue = sessionFeaturesHeaderValueOf(
    statusContext.modelRequestSessionFeatures,
  );
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
    ...(sessionFeaturesHeaderValue
      ? { [MODEL_SESSION_FEATURES_HEADER]: sessionFeaturesHeaderValue }
      : {}),
    ...(sessionHeaderValue ? { [MODEL_SESSION_HEADER]: sessionHeaderValue } : {}),
    ...(openCodeSessionHeaderValue ? { "x-opencode-session": openCodeSessionHeaderValue } : {}),
  };
}

/**
 * Deduplicated and joined in lexicographic order; if any tag is invalid or the total length overflows, the whole header is omitted.
 * Same as query-source: invalid values are just omitted, so HTTP header validation never blocks the model request, and there is no fallback to a static header.
 */
function sessionFeaturesHeaderValueOf(features: readonly string[] | undefined): string | undefined {
  if (features === undefined || features.length === 0) return undefined;
  if (!features.every((feature) => SESSION_FEATURE_VALUE_PATTERN.test(feature))) return undefined;
  const value = [...new Set(features)].sort().join(SESSION_FEATURES_SEPARATOR);
  return value.length <= SESSION_FEATURES_HEADER_MAX_LENGTH ? value : undefined;
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
