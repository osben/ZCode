import {
  LSP_FRAME_HEADER_MAX_BYTES,
  LSP_CONTENT_LENGTH_HEADER,
  LSP_HEADER_SEPARATOR,
  LSP_JSON_RPC_VERSION,
} from "./constants.js";

export type JsonRpcId = number | string;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: typeof LSP_JSON_RPC_VERSION;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** Peer sent bytes that are not a Content-Length framed JSON-RPC message. The stream is unusable. */
export class JsonRpcFramingError extends Error {
  override readonly name = "JsonRpcFramingError";
}

/** Thrown by a server-request handler to answer with a specific JSON-RPC error code. */
export class JsonRpcResponseError extends Error {
  override readonly name = "JsonRpcResponseError";

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function encodeJsonRpcFrame(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}${LSP_HEADER_SEPARATOR}`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. Chunks may split headers or bodies anywhere, and one chunk may hold several
 * messages. Lengths are byte counts, so multi-byte UTF-8 bodies are handled by slicing buffers.
 */
export class JsonRpcFrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.pending = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.pending.indexOf(LSP_HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.pending.byteLength > LSP_FRAME_HEADER_MAX_BYTES) {
          throw new JsonRpcFramingError(
            `LSP header exceeds ${LSP_FRAME_HEADER_MAX_BYTES} bytes without a terminator`,
          );
        }
        break;
      }
      const bodyLength = parseContentLength(this.pending.subarray(0, headerEnd).toString("utf8"));
      const bodyStart = headerEnd + LSP_HEADER_SEPARATOR.length;
      const frameEnd = bodyStart + bodyLength;
      if (this.pending.byteLength < frameEnd) break;
      const body = this.pending.subarray(bodyStart, frameEnd);
      this.pending = this.pending.subarray(frameEnd);
      messages.push(parseBody(body));
    }
    return messages;
  }
}

function parseContentLength(headerText: string): number {
  let contentLength: number | undefined;
  for (const line of headerText.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new JsonRpcFramingError(
        `malformed LSP header line: ${JSON.stringify(line.slice(0, 80))}`,
      );
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== LSP_CONTENT_LENGTH_HEADER) continue;
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/u.test(value)) {
      throw new JsonRpcFramingError("Content-Length header is not a non-negative integer");
    }
    contentLength = Number(value);
  }
  if (contentLength === undefined || !Number.isSafeInteger(contentLength)) {
    throw new JsonRpcFramingError("LSP header block has no usable Content-Length");
  }
  return contentLength;
}

function parseBody(body: Buffer): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new JsonRpcFramingError("LSP message body is not valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JsonRpcFramingError("LSP message body is not a JSON object");
  }
  return parsed as JsonRpcMessage;
}
