import { gunzipSync, zstdDecompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applySiwcRequestShape, createSiwcCompatFetch } from "../src/model/siwc-request-compat.js";
import {
  compressRequestBodyIfNeeded,
  DEFAULT_REQUEST_BODY_COMPRESSION_THRESHOLD_BYTES,
} from "../src/model/request-body-compression.js";

interface CapturedRequest {
  body: string | Uint8Array;
  headers: Record<string, string>;
  url: string;
}

function createCapturingFetch() {
  const requests: CapturedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      body: init?.body as string | Uint8Array,
      headers,
      url: String(input),
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, requests };
}

const RICH_BODY = JSON.stringify({
  model: "gpt-6.1-sol",
  instructions: "You are a coding agent.",
  input: [
    { type: "message", role: "user", content: "hello" },
    { type: "message", role: "system", content: "extra system line" },
  ],
  tools: [{ type: "function", name: "read_file", parameters: {} }],
  // Injected by catalog option maps / request options; all forbidden on the SIWC route.
  max_output_tokens: 128000,
  max_completion_tokens: 128000,
  temperature: 0.7,
  top_p: 0.9,
  metadata: { session: "x" },
  user: "user-1",
  previous_response_id: "resp_1",
  truncation: "auto",
  store: true,
  stream: false,
});

describe("SIWC request compat fetch (wire shaping)", () => {
  it("strips forbidden fields, forces store:false and stream:true, and remaps system input items", async () => {
    const { fetchFn, requests } = createCapturingFetch();
    const fetchCompat = createSiwcCompatFetch(fetchFn);
    await fetchCompat("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer siwc-access-token" },
      body: RICH_BODY,
    });

    expect(requests).toHaveLength(1);
    const sent = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
    expect(sent.store).toBe(false);
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe("gpt-6.1-sol");
    expect(sent.tools).toEqual([{ type: "function", name: "read_file", parameters: {} }]);
    for (const field of [
      "max_output_tokens",
      "max_completion_tokens",
      "temperature",
      "top_p",
      "metadata",
      "user",
      "previous_response_id",
      "truncation",
    ]) {
      expect(sent[field], `${field} must be stripped`).toBeUndefined();
    }
    // The system item is folded into instructions; no system-role items remain on the wire.
    expect((sent.input as { role?: string }[]).some((item) => item.role === "system")).toBe(false);
    expect(String(sent.instructions)).toContain("You are a coding agent.");
    expect(String(sent.instructions)).toContain("extra system line");
    // Authorization (the SIWC access token) passes through untouched.
    expect(requests[0]!.headers.authorization).toBe("Bearer siwc-access-token");
    expect(Number(requests[0]!.headers["content-length"])).toBe(
      Buffer.byteLength(String(requests[0]!.body), "utf-8"),
    );
  });

  it("leaves bodies without system items untouched in their ordering", () => {
    const shaped = applySiwcRequestShape({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "hi" }],
      max_output_tokens: 5,
    });
    expect(shaped.input).toEqual([{ type: "message", role: "user", content: "hi" }]);
    expect(shaped.instructions).toBeUndefined();
    expect("max_output_tokens" in shaped).toBe(false);
  });

  it("compresses bodies over the threshold with zstd and sets content-encoding", async () => {
    const { fetchFn, requests } = createCapturingFetch();
    const fetchCompat = createSiwcCompatFetch(fetchFn, { compressionThresholdBytes: 100 });
    const bigBody = JSON.stringify({
      model: "gpt-6.1-sol",
      input: [{ type: "message", role: "user", content: "x".repeat(500) }],
    });
    await fetchCompat("https://api.openai.com/v1/responses", { method: "POST", body: bigBody });

    const captured = requests[0]!;
    expect(captured.headers["content-encoding"]).toBe("zstd");
    const decompressed = zstdDecompressSync(Buffer.from(captured.body as Uint8Array)).toString(
      "utf-8",
    );
    const parsed = JSON.parse(decompressed) as Record<string, unknown>;
    expect(parsed.store).toBe(false);
    expect(parsed.stream).toBe(true);
    expect(Number(captured.headers["content-length"])).toBe(
      (captured.body as Uint8Array).byteLength,
    );
  });

  it("compresses a real >1 MiB body at the default threshold", async () => {
    const { fetchFn, requests } = createCapturingFetch();
    const fetchCompat = createSiwcCompatFetch(fetchFn);
    const bigBody = JSON.stringify({
      model: "gpt-6.1-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: "y".repeat(DEFAULT_REQUEST_BODY_COMPRESSION_THRESHOLD_BYTES + 1),
        },
      ],
    });
    expect(Buffer.byteLength(bigBody, "utf-8")).toBeGreaterThan(
      DEFAULT_REQUEST_BODY_COMPRESSION_THRESHOLD_BYTES,
    );
    await fetchCompat("https://api.openai.com/v1/responses", { method: "POST", body: bigBody });
    expect(requests[0]!.headers["content-encoding"]).toBe("zstd");
  });

  it("falls back to gzip when zstd is unavailable", () => {
    const payload = JSON.stringify({ input: "z".repeat(300) });
    const gzipOnly = { gzipSync } satisfies { gzipSync: typeof gzipSync };
    const compressed = compressRequestBodyIfNeeded(payload, {
      thresholdBytes: 100,
      zlib: gzipOnly,
    });
    expect(compressed?.contentEncoding).toBe("gzip");
    const restored = gunzipSync(Buffer.from(compressed!.body)).toString("utf-8");
    expect(JSON.parse(restored)).toEqual(JSON.parse(payload));
  });

  it("prefers zstd when the runtime provides it", () => {
    const payload = JSON.stringify({ input: "z".repeat(300) });
    const compressed = compressRequestBodyIfNeeded(payload, { thresholdBytes: 100 });
    expect(compressed?.contentEncoding).toBe("zstd");
    const restored = zstdDecompressSync(Buffer.from(compressed!.body)).toString("utf-8");
    expect(JSON.parse(restored)).toEqual(JSON.parse(payload));
  });

  it("passes through requests without a JSON body", async () => {
    const { fetchFn, requests } = createCapturingFetch();
    const fetchCompat = createSiwcCompatFetch(fetchFn);
    const response = await fetchCompat("https://api.openai.com/v1/models");
    expect(response.status).toBe(200);
    expect(requests[0]!.body).toBeUndefined();
  });

  it("rejects non-JSON bodies instead of sending them unshaped", async () => {
    const { fetchFn } = createCapturingFetch();
    const fetchCompat = createSiwcCompatFetch(fetchFn);
    await expect(
      fetchCompat("https://api.openai.com/v1/responses", { method: "POST", body: "not-json" }),
    ).rejects.toThrow(/JSON object body/u);
  });
});
