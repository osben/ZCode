// ZCode Protocol v4 — draft data model (not frozen; golden tests define the finalized schemas).
// Package rule: contain only schema types and pure functions; no runtime, I/O, or transport logic.
import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "../zcode-media-policy.js";

/** V4 physical wire protocol version; projection snapshots continue to use protocolVersion=1 independently. */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

/** V3 row target: display rows and stable entities must be committed together and validated by the same authoritative projection. */
export const conversationRowTargetSchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    entityId: z.string().trim().min(1),
  })
  .strict();
export type ConversationRowTarget = z.infer<typeof conversationRowTargetSchema>;

// Clock rule: Unix milliseconds, always using the CLI clock. Clients must not subtract protocol timestamps from their local clock.
export const timestampSchema = z.number();
export type Timestamp = z.infer<typeof timestampSchema>;

// Delivery profile exists only in the CLI flush-pipeline parameter table; client code must not contain profile variables.
export const streamablePathSchema = z.enum(["text", "inputText", "output.text", "summaryText"]);
export type StreamablePath = z.infer<typeof streamablePathSchema>;

export interface DeliveryProfile {
  desktopOnlyRows: boolean;
  flushWindowMs: number;
  streamPaths: Record<StreamablePath, boolean>;
  streamOutputCapBytes: number;
  toolProgress: boolean;
}

export const DELIVERY_PROFILES = {
  continuous: {
    desktopOnlyRows: true,
    flushWindowMs: 30,
    streamPaths: {
      text: true,
      inputText: true,
      "output.text": true,
      summaryText: true,
    },
    streamOutputCapBytes: 262144,
    toolProgress: false,
  },
  replayable: {
    desktopOnlyRows: false,
    flushWindowMs: 150,
    streamPaths: {
      text: true,
      inputText: false,
      "output.text": false,
      summaryText: false,
    },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} as const satisfies Record<string, DeliveryProfile>;

export type DeliveryProfileName = keyof typeof DELIVERY_PROFILES;

// Constants and limits (initial values; tune based on measurements).
export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
  transportEnvelopeIdMaxChars: 256,
  subscriberBufferMaxOps: 500,
  subscriberBufferMaxBytes: 1024 * 1024,
  eventRetentionPerSession: 2000,
  snapshotTailWindowRows: 60,
  rowsRangeMaxLimit: 200,
  toolOutputFinalHeadBytes: 32 * 1024,
  toolOutputFinalTailBytes: 32 * 1024,
  goalVerificationsRetained: 20,
  pendingCommandsDisplayMax: 32,
  commandPendingTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTablePerSession: 512,
  conversationQueryTimeoutMs: 10_000,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
  attachmentPreviewMaxBytes: VIDEO_INPUT_MAX_BYTES,
  // Metadata-only stat during share selection previously reused attachmentPreviewMaxBytes (30 MiB) as
  // the totalBytes limit. Attachments larger than that failed schema validation, downgrading the
  // normally blocking "size exceeded" classification to deferred and silently dropping content. stat
  // does not transfer bytes; it only needs an upper bound large enough to represent the actual file size.
  attachmentStatMaxBytes: 2 * 1024 * 1024 * 1024,
  attachmentPreviewMaxChunks: VIDEO_INPUT_MAX_BYTES / (512 * 1024),
  attachmentReadCacheMaxBytes: VIDEO_INPUT_MAX_BYTES,
  attachmentReadCacheTtlMs: 30_000,
  attachmentUploadMaxChunks: 64,
  attachmentUploadMaxConcurrent: 16,
  attachmentUploadMaxStagedBytes: 64 * 1024 * 1024,
  attachmentUploadTtlMs: 5 * 60_000,
  attachmentUnreferencedTtlMs: 24 * 60 * 60 * 1000,
} as const;
