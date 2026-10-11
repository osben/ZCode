import { useEffect, useMemo, useRef, useState } from "react";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Read bytes for content artifacts (`file` / `markdown`).
 *
 * Follow the chunking pattern of `attachmentRead`: each chunk is ≤ 512 KiB, and a null `nextOffset`
 * means the read is complete. The full in-memory size is capped by `ARTIFACT_CAPS.maxFileBytes`
 * (= 20 MiB, the same limit as attachments). At this size, assembling one Blob is much simpler than
 * making each viewer perform range reads; the existing leaf viewers need a Blob / ArrayBuffer, not a cursor.
 *
 * ```
 * offset 0 ──read──▶ {dataBase64, mediaType, totalBytes, nextOffset}
 *        ◀──────────  decode into Uint8Array and add to chunks[]
 *   nextOffset ──read──▶ …  until null
 *        ▼
 *   assemble into one Uint8Array ─▶ Blob ─▶ objectUrl (revoke on unmount / version change)
 * ```
 */

/** Bytes per chunk. Reuse the attachment constant; it is also the gateway's limit. */
const CHUNK_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;

/**
 * Maximum chunks to read for one artifact. 20 MiB / 512 KiB = 40 chunks; allow twice that as a
 * guard against infinite loops. An implementation that never resolves `nextOffset` to null must
 * not lock up the renderer.
 */
const MAX_CHUNKS = 96;

interface WorkflowRunArtifactBytesState {
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  /** Blob object URL used by `<img src>` / PdfViewer. Automatically revoked on unmount and version change. */
  objectUrl: string | null;
  /** contentType from the journal record (not re-detected by the store); the renderer dispatches on an exact match. */
  mediaType: string | null;
  totalBytes: number | null;
  loading: boolean;
  error: string | null;
  /**
   * which version owns `bytes`. After a version change, before the effect clears the old state, there is one frame where `version` is new but `bytes`
   * still belongs to the old version. A one-frame viewer flash is acceptable, but an “Open as file” copy is written only once, so using the wrong bytes would permanently corrupt it—
   * consumers like this must verify the version instead of trusting the currently rendered `version`.
   */
  bytesVersion: number | null;
}

function emptyState(): WorkflowRunArtifactBytesState {
  return {
    bytes: null,
    blob: null,
    objectUrl: null,
    mediaType: null,
    totalBytes: null,
    loading: false,
    error: null,
    bytesVersion: null,
  };
}

/** base64 → bytes. `atob` is always available in the renderer (Electron and browsers both use Chromium). */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * bytes → base64. The office viewer accepts only `FileBinaryPreview.dataBase64`, so this conversion is needed.
 *
 * Process in chunks (8 KiB) instead of using `String.fromCharCode(...bytes)`: the latter fails with
 * "Maximum call stack size exceeded" at 20 MiB because it expands to 20 million arguments.
 */
export function encodeBytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const step = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export function useWorkflowRunArtifactBytes(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  version: number;
  /** When false, do not read or retain any object URL (used by preset dashboards and collapsed states to skip the whole flow). */
  enabled?: boolean;
}): WorkflowRunArtifactBytesState {
  const { workflowRunArtifactRead } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactBytesState>(emptyState);
  // Created object URLs must be revoked on unmount and version change; otherwise each version leaks up to 20 MiB.
  const objectUrlRef = useRef<string | null>(null);

  const { artifactId, runId, sessionId, version } = options;
  const enabled =
    options.enabled !== false &&
    sessionId.length > 0 &&
    runId.length > 0 &&
    artifactId.length > 0 &&
    version > 0;

  useEffect(() => {
    const revokePrevious = () => {
      if (objectUrlRef.current !== null) {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = null;
      }
    };
    revokePrevious();
    setState(emptyState());
    if (!enabled) return;

    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        let mediaType = "application/octet-stream";
        let totalBytes = 0;
        for (let index = 0; index < MAX_CHUNKS; index += 1) {
          const result = await workflowRunArtifactRead({
            sessionId,
            runId,
            artifactId,
            version,
            offset,
            limit: CHUNK_BYTES,
          });
          if (!alive) return;
          mediaType = result.mediaType;
          totalBytes = result.totalBytes;
          chunks.push(decodeBase64(result.dataBase64));
          if (result.nextOffset === null) break;
          offset = result.nextOffset;
        }
        if (!alive) return;
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, cursor);
          cursor += chunk.length;
        }
        const blob = new Blob([bytes], { type: mediaType });
        // jsdom has no createObjectURL. Missing a URL is not an error; it only prevents the `<img>` path.
        // The Blob / bytes paths still work (PdfViewer and the office viewer use them).
        const objectUrl =
          typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(blob)
            : null;
        objectUrlRef.current = objectUrl;
        setState({
          bytes,
          blob,
          objectUrl,
          mediaType,
          totalBytes,
          loading: false,
          error: null,
          bytesVersion: version,
        });
      } catch (caught) {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] 读取产物字节失败", {
          artifactId,
          error: message,
          runId,
          sessionId,
          version,
        });
        setState({ ...emptyState(), error: message });
      }
    })();

    return () => {
      alive = false;
      revokePrevious();
    };
  }, [artifactId, enabled, runId, sessionId, version, workflowRunArtifactRead]);

  return useMemo(() => state, [state]);
}
