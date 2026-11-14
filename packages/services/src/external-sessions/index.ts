export { createExternalSessionsService } from "#src/external-sessions/service.js";
export type { ExternalSessionsServiceOptions } from "#src/external-sessions/service.js";
export { createDefaultExternalSessionAdapters } from "#src/external-sessions/adapters/index.js";
export type {
  ExternalSessionScanContext,
  ExternalSessionSourceAdapter,
} from "#src/external-sessions/adapters/types.js";
export {
  EXTERNAL_SESSION_NOT_FOUND,
  EXTERNAL_SESSION_SOURCES,
  EXTERNAL_SESSION_SOURCE_CATALOG,
  EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE,
  IExternalSessionsService,
  buildExternalSessionResumeCommand,
  externalSessionSourceLabel,
  isSafeExternalSessionId,
} from "#src/external-sessions/contract.js";
export type {
  ExternalSessionRef,
  ExternalSessionSource,
  ExternalSessionSourceInfo,
  ExternalSessionSourceStatus,
  ExternalSessionSummary,
  ExternalSessionTerminalResult,
  ExternalSessionTranscript,
  ExternalSessionTranscriptMessage,
  ExternalSessionsListParams,
  ExternalSessionsListResult,
} from "#src/external-sessions/contract.js";
