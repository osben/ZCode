import * as zlib from "node:zlib";

/**
 * Request-body compression for providers that reject large uncompressed bodies.
 *
 * Provider-agnostic transport utility: compression is a per-endpoint server capability, so it
 * stays default-off; adopt it per provider only after verifying the endpoint accepts the
 * encoding. The SIWC direct route (~1 MiB body cap) is the first consumer.
 */

export const DEFAULT_REQUEST_BODY_COMPRESSION_THRESHOLD_BYTES = 1_048_576;

export type RequestBodyCompressionEncoding = "zstd" | "gzip";

export interface CompressedRequestBody {
  readonly body: Uint8Array;
  readonly contentEncoding: RequestBodyCompressionEncoding;
}

/**
 * Compress a serialized request body when it exceeds the threshold.
 *
 * zstd is preferred (best ratio; feature-detected because only newer Node ships it in
 * node:zlib) with a gzip fallback so older runtimes keep working. Returns undefined when
 * the body is below the threshold.
 */
export function compressRequestBodyIfNeeded(
  serializedBody: string,
  options: {
    readonly thresholdBytes?: number;
    /** Injectable zlib surface for tests; defaults to node:zlib. */
    readonly zlib?: Pick<typeof zlib, "zstdCompressSync" | "gzipSync">;
  } = {},
): CompressedRequestBody | undefined {
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_REQUEST_BODY_COMPRESSION_THRESHOLD_BYTES;
  const bytes = Buffer.byteLength(serializedBody, "utf-8");
  if (bytes <= thresholdBytes) {
    return undefined;
  }
  const engine = options.zlib ?? zlib;
  const buffer = Buffer.from(serializedBody, "utf-8");
  if (typeof engine.zstdCompressSync === "function") {
    return { body: engine.zstdCompressSync(buffer), contentEncoding: "zstd" };
  }
  return { body: engine.gzipSync(buffer), contentEncoding: "gzip" };
}
