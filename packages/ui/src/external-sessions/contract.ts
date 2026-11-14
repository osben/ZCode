/**
 * external-sessions-ui contract layer: the only file of this module that imports @zcode/services.
 * Re-exports the browser-safe service contract for the panel (specs/external-sessions.md).
 */
export {
  EXTERNAL_SESSION_SOURCE_CATALOG,
  EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE,
  externalSessionSourceLabel,
} from "@zcode/services";
export type {
  ExternalSessionSource,
  ExternalSessionSourceStatus,
  ExternalSessionSummary,
  ExternalSessionTranscript,
  ExternalSessionsListResult,
  IExternalSessionsService,
} from "@zcode/services";
