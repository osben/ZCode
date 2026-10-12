import type { ApiClient } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { debugLog, warnLog } = vi.hoisted(() => ({ debugLog: vi.fn(), warnLog: vi.fn() }));

vi.mock("#src/logger/serviceLogger.js", () => ({
  createServiceLogger: () => ({
    debug: debugLog,
    info: vi.fn(),
    warn: warnLog,
    error: vi.fn(),
  }),
}));

import {
  ConversationShareClientError,
  ConversationShareHttpClient,
} from "../src/conversation-share/conversationShareHttpClient.js";
import { sha256ConversationShareJson } from "../src/conversation-share/conversationShareIntegrity.js";

const SHA_256 = "a".repeat(64);
/** Continuation integrity is re-checked by the client, so the fixture must carry a real hash instead of a placeholder string. */
const EMPTY_PROJECTION_SHA_256 = sha256ConversationShareJson([]);

function success(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createClient(
  request: ApiClient["request"],
  tokenProvider: () => Promise<string | null> = async () => "test-token",
) {
  return new ConversationShareHttpClient({
    apiClient: { request },
    baseUrl: "https://api.example.com/api/v1",
    tokenProvider,
  });
}

function makeConfirmRequest() {
  return {
    selected_product_turn_ids: ["share-product-turn-1"],
    projection: {
      rows: [
        {
          rowId: 1,
          turnId: "share-turn-1",
          productTurnId: "share-product-turn-1",
          createdAt: 1_000,
          createdAtSeq: 1,
          kind: "turnHeader" as const,
          origin: "userInput" as const,
          state: "completedSuccess" as const,
          startedAt: 1_000,
          endedAt: 1_100,
        },
      ],
    },
    integrity: {
      projection_sha256: SHA_256,
      artifact_set_sha256: SHA_256,
    },
    disclosure_confirmation: {
      version: 1 as const,
      accepted_at: 1_200,
      acknowledged_no_secret_detection: true as const,
    },
  };
}

describe("ConversationShareHttpClient", () => {
  beforeEach(() => {
    debugLog.mockReset();
    warnLog.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes request ids on client error construction", () => {
    const error = new ConversationShareClientError({
      kind: "unknown",
      message: "bad request id",
      requestId: "https://signed.example/token",
    });

    expect(error.requestId).toBeUndefined();
    expect(error.details).toBeUndefined();
  });

  it("requests capabilities with Bearer authentication", async () => {
    const request = vi.fn(async () =>
      success({
        schema_version: 1,
        ttl_ms: 1_000,
        access_modes: ["private", "public_readonly", "public_importable"],
        max_rows: 500,
        max_payload_bytes: 4_194_304,
        max_artifact_count: 20,
        max_artifact_bytes: 20_971_520,
        max_total_artifact_bytes: 104_857_600,
        allowed_artifacts: [],
      }),
    );

    const capabilities = await createClient(request).getCapabilities();

    expect(capabilities.max_rows).toBe(500);
    expect(request.mock.calls[0]?.[0]).toBe("https://api.example.com/api/v1/shares/capabilities");
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
  });

  // Production incident: the backend added a type to allowed_artifacts that the client enum did not have,
  // the whole capabilities response failed validation and threw invalid_contract, killing publishing at
  // the collecting stage — even publishes containing no artifacts at all went down. Unknown types must be
  // dropped rather than rejecting the entire response.
  it("drops unknown allowed artifact types instead of rejecting capabilities", async () => {
    const request = vi.fn(async () =>
      success({
        schema_version: 1,
        ttl_ms: 1_000,
        access_modes: ["private"],
        max_rows: 500,
        max_payload_bytes: 4_194_304,
        max_artifact_count: 20,
        max_artifact_bytes: 20_971_520,
        max_total_artifact_bytes: 104_857_600,
        allowed_artifacts: [
          { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
          { type: "markdown", extensions: ["md"], mime_types: ["text/markdown"] },
          { type: "html", extensions: ["html"], mime_types: ["text/html"] },
        ],
      }),
    );

    const capabilities = await createClient(request).getCapabilities();

    expect(capabilities.allowed_artifacts.map((entry) => entry.type)).toEqual(["pdf", "html"]);
    expect(capabilities.max_rows).toBe(500);
  });

  it("still rejects capabilities whose allowed artifact shape changed", async () => {
    // Shape changes (renamed/missing fields) must still fail loudly, otherwise the client would wrongly believe "nothing is allowed".
    const request = vi.fn(async () =>
      success({
        schema_version: 1,
        ttl_ms: 1_000,
        access_modes: ["private"],
        max_rows: 500,
        max_payload_bytes: 4_194_304,
        max_artifact_count: 20,
        max_artifact_bytes: 20_971_520,
        max_total_artifact_bytes: 104_857_600,
        allowed_artifacts: [{ type: "pdf", extension: ["pdf"], mime_types: ["application/pdf"] }],
      }),
    );

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "invalid_contract",
    });
  });

  it("serializes preparation as strict JSON", async () => {
    const request = vi.fn(async () =>
      success({
        preparation_id: "preparation-1",
        status: "preparing",
        access_mode: "public_readonly",
        expires_at: 2_000,
      }),
    );

    await createClient(request).createPreparation({
      client_request_id: "request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "public_readonly",
      payload_sha256: SHA_256,
      artifact_count: 0,
    });

    const init = request.mock.calls[0]?.[1];
    expect(request.mock.calls[0]?.[0]).toBe("https://api.example.com/api/v1/shares/preparations");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      client_request_id: "request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "public_readonly",
      payload_sha256: SHA_256,
      artifact_count: 0,
    });
  });

  it("serializes confirm without logging conversation payload", async () => {
    const request = vi.fn(async () =>
      success({
        share_code: "share-1",
        share_url: "https://zcode.z.ai/cn/share/share-1",
        access_mode: "public_importable",
        expires_at: 2_000,
      }),
    );
    const confirmRequest = makeConfirmRequest();

    await createClient(request).confirm("preparation-1", confirmRequest);

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(confirmRequest);
    expect(debugLog).not.toHaveBeenCalled();
    expect(JSON.stringify(debugLog.mock.calls)).not.toContain("test-token");
  });

  it("uploads descriptor and binary as multipart fields", async () => {
    const request = vi.fn(async () =>
      success({
        artifact_id: "artifact-1",
        size_bytes: 3,
        sha256: SHA_256,
        status: "uploaded",
        safety_status: "pending",
      }),
    );
    const descriptor = {
      artifact_id: "artifact-1",
      logical_artifact_key: "report",
      producer_product_turn_id: "product-turn-1",
      artifact_version: 1,
      state: "current" as const,
      ref: "zcode-artifact://share/artifact-1",
      artifact_type: "html" as const,
      display_name: "report.html",
      extension: "html",
      mime_type: "text/html",
      size_bytes: 3,
      sha256: SHA_256,
    };

    const upload = await createClient(request).uploadArtifact(
      "preparation / 1",
      descriptor,
      new Blob(["abc"], { type: "text/html" }),
    );
    expect(upload.safety_status).toBe("pending");

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v1/shares/preparations/preparation%20%2F%201/artifacts",
    );
    const body = request.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(JSON.parse(String(form.get("descriptor")))).toEqual(descriptor);
    expect(await (form.get("file") as Blob).text()).toBe("abc");
    expect(debugLog).toHaveBeenCalledWith(
      undefined,
      "conversation share artifact upload prepared",
      {
        preparationId: "preparation / 1",
        artifactId: "artifact-1",
        artifactType: "html",
        fileSizeBytes: 3,
      },
    );
    expect(JSON.stringify(debugLog.mock.calls)).not.toContain("abc");
  });

  it("allows anonymous preview without Authorization", async () => {
    const request = vi.fn(async () =>
      success({
        schema_version: 1,
        share: {
          title: "分享标题",
          access_mode: "public_readonly",
          created_at: 1,
          expires_at: 2,
        },
        rows: [],
        artifacts: [],
        integrity: {
          projection_sha256: SHA_256,
          artifact_set_sha256: SHA_256,
        },
      }),
    );

    await createClient(request, async () => null).getPreview("share / 1");

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v1/shares/share%20%2F%201/preview",
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("sends continuation without Authorization when the local token is missing", async () => {
    const request = vi.fn(async () =>
      success({
        schema_version: 1,
        import_grant_id: "grant-1",
        import_grant_expires_at: 2_000,
        share: {
          share_id: "share-1",
          title: "分享标题",
          access_mode: "public_importable",
          created_at: 1,
          expires_at: 2,
        },
        rows: [],
        artifacts: [],
        integrity: {
          projection_sha256: EMPTY_PROJECTION_SHA_256,
          artifact_set_sha256: EMPTY_PROJECTION_SHA_256,
        },
      }),
    );

    await createClient(request, async () => null).getContinuation("share / 1", {
      schema_version: 1,
      client_request_id: "request-1",
    });

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v1/shares/share%20%2F%201/continuation",
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("rejects authenticated routes before network when token is missing", async () => {
    const request = vi.fn<ApiClient["request"]>();

    await expect(createClient(request, async () => null).getCapabilities()).rejects.toMatchObject({
      kind: "authentication_required",
      status: 401,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes empty-body HTTP 401", async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "authentication_required",
      status: 401,
    });
  });

  it("normalizes documented business errors", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3209, msg: "share limit exceeded" }), {
          status: 413,
        }),
    );

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "limit_exceeded",
      status: 413,
      code: 3209,
      message: "share limit exceeded",
    });
  });

  it("does not expose the client request header when the response has no request id", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3209, msg: "share limit exceeded" }), {
          status: 413,
        }),
    );

    const error = await createClient(request)
      .getCapabilities()
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ kind: "limit_exceeded", status: 413, code: 3209 });
    expect((error as { requestId?: string }).requestId).toBeUndefined();
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("x-request-id")).toMatch(
      /^[A-Za-z0-9-]{20,}$/u,
    );
  });

  // Bug root cause: 5xx HTML error pages from the LB/gateway (502/504) were previously classified as
  // invalid_contract (meaning: server violated the contract) because the body could not be parsed as
  // JSON. This is an infrastructure failure; classifying it as network gives the right user guidance and
  // troubleshooting direction, while the request id is still kept for reconciliation.
  it("502 HTML 错误页归类 network 且保留 request id", async () => {
    const request = vi.fn(
      async () =>
        new Response("<html>not-json</html>", {
          status: 502,
          headers: { "X-Request-Id": "server-request-malformed" },
        }),
    );

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "network",
      status: 502,
      requestId: "server-request-malformed",
    });
  });

  it("504 空 body 响应也归类 network 而不是 unknown", async () => {
    const request = vi.fn(async () => new Response(null, { status: 504 }));

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "network",
      status: 504,
    });
  });

  it.each([400, 405])("HTTP %s 的非 JSON 错误响应归类接口契约异常", async (status) => {
    const request = vi.fn(async () => new Response("<html>bad-request</html>", { status }));

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "invalid_contract",
      status,
    });
  });

  // Retry-After only accepts delay-seconds and IMF-fixdate; any other value is treated as "the backend
  // gave no advice", letting the caller fall back to its own retry cadence — never parsed as 0 or NaN ms.
  it.each([
    { label: "a positive delay-seconds value", header: "7", expected: 7_000 },
    {
      label: "a future IMF-fixdate",
      header: "Thu, 12 Aug 2027 10:00:10 GMT",
      expected: 10_000,
      nowUtc: Date.UTC(2027, 7, 12, 10, 0, 0),
    },
    { label: "a zero delay", header: "0", expected: null },
    { label: "a non-IMF ISO date", header: "2027-08-12", expected: null },
    { label: "an invalid value", header: "invalid", expected: null },
  ])("maps safety-check pending with $label", async ({ header, expected, nowUtc }) => {
    if (nowUtc !== undefined) vi.spyOn(Date, "now").mockReturnValue(nowUtc);
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3215, msg: "share safety check pending" }), {
          status: 409,
          headers: { "Content-Type": "application/json", "Retry-After": header },
        }),
    );

    const error = await createClient(request)
      .confirm("preparation-1", makeConfirmRequest())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ kind: "safety_check_pending", status: 409, code: 3215 });
    if (expected === null) expect(error).not.toHaveProperty("retryAfterMs");
    else expect(error).toMatchObject({ retryAfterMs: expected });
  });

  it("keeps the response request id for safety-check pending", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3215, msg: "share safety check pending" }), {
          status: 409,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "server-request-3215",
          },
        }),
    );

    await expect(
      createClient(request).confirm("preparation-1", makeConfirmRequest()),
    ).rejects.toMatchObject({ kind: "safety_check_pending", requestId: "server-request-3215" });
  });

  it("preserves the server request id on rejected responses and logs it", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3209, msg: "share limit exceeded" }), {
          status: 413,
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "server-request-123",
          },
        }),
    );

    const error = await createClient(request)
      .confirm("preparation-1", makeConfirmRequest())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      kind: "limit_exceeded",
      code: 3209,
      requestId: "server-request-123",
    });
    expect(warnLog).toHaveBeenCalledWith(
      undefined,
      "conversation share API request rejected",
      expect.objectContaining({
        path: "/shares/preparations/preparation-1/confirm",
        status: 413,
        requestId: "server-request-123",
        code: 3209,
      }),
    );
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain("test-token");
  });

  it("rejects malformed successful envelopes as invalid_contract", async () => {
    const request = vi.fn(async () => success({ schema_version: 2 }));

    await expect(createClient(request).getCapabilities()).rejects.toBeInstanceOf(
      ConversationShareClientError,
    );
    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "invalid_contract",
      status: 200,
    });
  });

  it("preserves response request id for malformed successful envelopes", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, msg: "", data: { schema_version: 2 } }), {
          status: 200,
          headers: { "X-Request-Id": "server-request-contract" },
        }),
    );

    await expect(createClient(request).getCapabilities()).rejects.toMatchObject({
      kind: "invalid_contract",
      status: 200,
      requestId: "server-request-contract",
    });
  });

  it("does not attach a request id to network errors", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });

    const error = await createClient(request)
      .getCapabilities()
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ kind: "network" });
    expect((error as { requestId?: string }).requestId).toBeUndefined();
  });

  it("confirm 用更长的单次超时，其它端点保持 30s", async () => {
    // Bug root cause: the server runs safety checks synchronously inside confirm, requests hung 50s+ and
    // hit the 30s cap and were aborted, so publishing failed at the checking stage with network. The
    // polling timeout only governs retries after "the server has returned pending"; it cannot save the
    // single request itself.
    const request = vi.fn(async (_url: string, init?: { timeoutMs?: number }) => {
      void init;
      return success({
        share_code: "share-1",
        share_url: "https://zcode.z.ai/cn/share/share-1",
        access_mode: "private",
        expires_at: 20_000,
      });
    });
    const client = createClient(request as never);

    await client.confirm("preparation-1", makeConfirmRequest());
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(120_000);

    request.mockClear();
    // Only the timeoutMs passed down matters here; a response body failing the preview schema errors after the request and does not affect the assertion.
    await client.getPreview("share-1").catch(() => undefined);
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("confirmTimeoutMs 可覆盖，便于测试与调优", async () => {
    const request = vi.fn(async () =>
      success({
        share_code: "share-1",
        share_url: "https://zcode.z.ai/cn/share/share-1",
        access_mode: "private",
        expires_at: 20_000,
      }),
    );
    const client = new ConversationShareHttpClient({
      apiClient: { request: request as never },
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "test-token",
      confirmTimeoutMs: 5_000,
    });

    await client.confirm("preparation-1", makeConfirmRequest());
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(5_000);
  });

  // Bug root cause: uploadArtifact previously reused the 30s default timeout — confirm was already
  // observed hanging a single request 50s+ (see above), so larger artifacts over a slow uplink would
  // surely time out with no automatic retry. The timeout scales dynamically with size:
  // 30s base margin + a guaranteed 128KB/s uplink, still floored at the global default timeout.
  it("uploadArtifact 按文件体积动态放宽超时", async () => {
    const request = vi.fn(async () =>
      success({
        artifact_id: "artifact-1",
        size_bytes: 3,
        sha256: SHA_256,
        status: "uploaded",
        safety_status: "pending",
      }),
    );
    const client = createClient(request as never);
    const descriptor = {
      artifact_id: "artifact-1",
      logical_artifact_key: "report",
      producer_product_turn_id: "product-turn-1",
      artifact_version: 1,
      state: "current" as const,
      ref: "zcode-artifact://share/artifact-1",
      artifact_type: "html" as const,
      display_name: "report.html",
      extension: "html",
      mime_type: "text/html",
      size_bytes: 3,
      sha256: SHA_256,
    };

    // Small file: base margin + 1s, still above the 30s default.
    await client.uploadArtifact("preparation-1", descriptor, new Blob(["abc"]));
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(31_000);

    request.mockClear();
    // 5 MiB: 30s + 40s (5 MiB ÷ 128KB/s, rounded up) = 70s.
    const fiveMiB = new Uint8Array(5 * 1024 * 1024);
    await client.uploadArtifact("preparation-1", descriptor, new Blob([fiveMiB]));
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(70_000);
  });

  it("uploadTimeoutMs 下限仍是全局默认超时，避免小请求被缩短", async () => {
    const request = vi.fn(async () =>
      success({
        artifact_id: "artifact-1",
        size_bytes: 3,
        sha256: SHA_256,
        status: "uploaded",
        safety_status: "pending",
      }),
    );
    const client = new ConversationShareHttpClient({
      apiClient: { request: request as never },
      baseUrl: "https://api.example.com/api/v1",
      tokenProvider: async () => "test-token",
      timeoutMs: 120_000,
    });
    const descriptor = {
      artifact_id: "artifact-1",
      logical_artifact_key: "report",
      producer_product_turn_id: "product-turn-1",
      artifact_version: 1,
      state: "current" as const,
      ref: "zcode-artifact://share/artifact-1",
      artifact_type: "html" as const,
      display_name: "report.html",
      extension: "html",
      mime_type: "text/html",
      size_bytes: 3,
      sha256: SHA_256,
    };

    await client.uploadArtifact("preparation-1", descriptor, new Blob(["abc"]));
    expect((request.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(120_000);
  });
});

describe("分享响应读取失败", () => {
  it("响应体中断保留状态及双方请求 ID，并归类网络错误", async () => {
    let sentRequestId: string | null = null;
    const response = new Response(null, {
      status: 200,
      headers: { "x-request-id": "server-read-id" },
    });
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("terminated"));
    const client = createClient(async (_url, init) => {
      sentRequestId = new Headers(init?.headers).get("x-request-id");
      return response;
    });
    const error = await client
      .confirm("preparation-read", makeConfirmRequest())
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      kind: "network",
      status: 200,
      requestId: "server-read-id",
    });
    expect(sentRequestId).toBeTruthy();
    expect(error).toMatchObject({
      details: {
        clientRequestId: sentRequestId,
        status: 200,
        requestId: "server-read-id",
      },
    });
  });
});

it("非 JSON 错误诊断不记录响应正文或查询参数", async () => {
  warnLog.mockClear();
  const response = new Response("<html>private-user-data</html>", {
    status: 405,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const error = await createClient(async () => response)
    .confirm("diagnostic-preparation", makeConfirmRequest())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    kind: "invalid_contract",
    status: 405,
    details: { clientRequestId: expect.any(String) },
  });
  expect(error).not.toHaveProperty("cause");
  expect(warnLog).toHaveBeenCalledWith(
    undefined,
    "conversation share HTTP response diagnostics",
    expect.objectContaining({
      method: "POST",
      status: 405,
      responseFormat: "html",
      mediaType: "text/html",
      clientRequestId: expect.any(String),
    }),
  );
  expect(JSON.stringify(warnLog.mock.calls)).not.toContain("private-user-data");
});
