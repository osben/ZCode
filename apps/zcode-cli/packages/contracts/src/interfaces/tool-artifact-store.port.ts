// ============================================================
// Tool Artifact Store Port - large tool result storage boundary
// ============================================================

import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export type ToolArtifactRetention = "session" | "project" | "temporary";

export interface ToolArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: string;
  contentType?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolBinaryArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: Uint8Array;
  contentType: string;
  extension?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolArtifactWriteResult {
  id: string;
  uri: string;
  path?: string;
  bytes: number;
  contentType: string;
  createdAt: Date;
}

export interface ToolArtifactReadRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactReadResult {
  uri: string;
  content: string;
  contentType: string;
  bytes: number;
  path?: string;
}

/**
 * Binary readback: **raw bytes**, with no text / base64 encoding.
 *
 * {@link ToolArtifactStorePort.readToolResultArtifact}
 * Treating "infer contentType again from the filename → decode text as UTF-8 and everything else as
 * base64" as the inverse of the write encoding is unsafe. The inference table recognizes only
 * txt/md/png/jpg/gif/webp/pdf/bin, so `.xlsx` / `.docx` / `.pptx` falls back to `application/json` and
 * is decoded as UTF-8—office files are corrupted on readback and cannot be recovered. Byte consumers
 * (v4 chunked reads, viewers) need the bytes themselves; encoding is for model-facing text. These are
 * separate methods. `contentType` is still inferred from the filename, only as a fallback for callers
 * without a better source (dwf uses the value recorded in the journal).
 */
export interface ToolBinaryArtifactReadResult {
  uri: string;
  bytes: Uint8Array;
  contentType: string;
  path?: string;
}

export interface ToolArtifactStatRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactStatResult {
  uri: string;
  bytes: number;
  contentType: string;
  path?: string;
  mtimeMs?: number;
}

export interface ImageAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathEnsureRequest {
  uri: string;
  mediaType: string;
}

export type MediaAttachmentPathResult =
  | { status: "ready"; path: string }
  | { status: "unsupported" };

export interface ToolArtifactStorePort {
  writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  writeToolResultBinaryArtifact?(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult>;
  /**
   * Read back raw bytes (see {@link ToolBinaryArtifactReadResult}). Optional: like
   * {@link writeToolResultBinaryArtifact}, stores without binary support need not implement it.
   * Consumers detect it with `typeof`; if absent, the store cannot provide bytes—do not fall back to
   * reading text and decoding it.
   */
  readToolResultBinaryArtifact?(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult>;
  statToolResultArtifact?(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult>;
  primeImageAttachmentPath?(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  primeMediaAttachmentPath?(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  ensureMediaAttachmentPath?(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult>;
}
