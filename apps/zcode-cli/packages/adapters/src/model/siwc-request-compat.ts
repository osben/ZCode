import { compressRequestBodyIfNeeded } from "./request-body-compression.js";

/**
 * Request shaping for ChatGPT plan providers under the official OpenAI SIWC token-sharing
 * program. Applied ONLY to chatgpt-account providers and ordered AFTER
 * model-option-map-fetch so it strips what catalog rules injected (notably
 * max_output_tokens, which SIWC rejects).
 */

type ProviderFetch = typeof globalThis.fetch;

/** Request fields the SIWC direct route rejects; they must never appear on the wire. */
export const SIWC_FORBIDDEN_REQUEST_FIELDS: readonly string[] = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_completion_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

export interface SiwcCompatFetchOptions {
  /** Body compression threshold; defaults to ~1 MiB (the direct route's body cap). */
  readonly compressionThresholdBytes?: number;
}

/**
 * Strip forbidden fields, force store:false + stream:true, guarantee no system-role input
 * items, and compress bodies over the threshold.
 *
 * store/stream are hard requirements of the token-sharing surface: the service rejects
 * store:true requests and the client contract assumes SSE responses (the streaming
 * execution path); forcing stream here also protects any non-streaming caller.
 */
export function createSiwcCompatFetch(
  baseFetch: ProviderFetch,
  options: SiwcCompatFetchOptions = {},
): ProviderFetch {
  return async (input, init) => {
    const bodyText = await readRequestBodyText(input, init);
    if (bodyText === undefined) {
      // Requests without a JSON body carry nothing to shape; pass through untouched.
      return baseFetch(input, init);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `SIWC request shaping requires a JSON object body: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const field of SIWC_FORBIDDEN_REQUEST_FIELDS) {
      delete body[field];
    }
    body.store = false;
    body.stream = true;
    // Explicit system-role input items are rejected by the direct route; the AI SDK maps
    // the system prompt to instructions, so any leftovers are folded in defensively.
    remapSystemInputItems(body);

    const serialized = JSON.stringify(body);
    const compressed = compressRequestBodyIfNeeded(serialized, {
      ...(options.compressionThresholdBytes === undefined
        ? {}
        : { thresholdBytes: options.compressionThresholdBytes }),
    });

    if (requestIsRequestInstance(input) && init === undefined) {
      // Rebuild from the Request object, replacing the body and affected headers.
      const headers = new Headers(input.headers);
      applyBodyHeaders(headers, serialized.length, compressed);
      return baseFetch(
        new Request(input, {
          body: compressed ? compressed.body : serialized,
          headers,
          duplex: "half",
        } as RequestInit),
      );
    }

    const headers = new Headers(init?.headers);
    applyBodyHeaders(headers, serialized.length, compressed);
    const nextInit: RequestInit = {
      ...(init ?? {}),
      // Copy into a fresh Uint8Array so the body is backed by a plain ArrayBuffer (BodyInit).
      body: compressed ? new Uint8Array(compressed.body) : serialized,
      headers,
    };
    return baseFetch(input, nextInit);
  };
}

/** Exposed for wire tests: the exact body transform without a transport. */
export function applySiwcRequestShape(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  for (const field of SIWC_FORBIDDEN_REQUEST_FIELDS) {
    delete next[field];
  }
  next.store = false;
  next.stream = true;
  remapSystemInputItems(next);
  return next;
}

function remapSystemInputItems(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input)) {
    return;
  }
  let systemText: string | undefined;
  const input = body.input.flatMap((item) => {
    const record =
      typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined;
    if (record?.type === "message" && record.role === "system") {
      const text = readItemText(record.content);
      if (text !== undefined) {
        systemText = systemText === undefined ? text : `${systemText}\n\n${text}`;
      }
      return [];
    }
    return [item];
  });
  if (systemText === undefined) {
    return;
  }
  body.input = input;
  body.instructions =
    typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${systemText}`
      : systemText;
}

function readItemText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "input_text"
        ? (part as Record<string, unknown>).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string");
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function applyBodyHeaders(
  headers: Headers,
  serializedLength: number,
  compressed: ReturnType<typeof compressRequestBodyIfNeeded>,
): void {
  headers.set("content-length", String(compressed ? compressed.body.byteLength : serializedLength));
  if (compressed) {
    headers.set("content-encoding", compressed.contentEncoding);
  } else {
    headers.delete("content-encoding");
  }
}

async function readRequestBodyText(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("SIWC request shaping requires a JSON text request body.");
  }
  if (requestIsRequestInstance(input)) return input.clone().text();
  return undefined;
}

function requestIsRequestInstance(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}
