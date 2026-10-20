/** Persistence contract for message.data metadata.highspeed; excludes runtime credentials. */
export interface HighspeedMessageMetadata {
  schemaVersion: 1;
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  fallbackAt?: number;
  fallbackReason?: "highspeed_card_expired" | "highspeed_request_failed" | "highspeed_selection_unavailable";
}
