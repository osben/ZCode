// Model-io stream timing contract (specs/model-io-stream-timing.md): every model-io record
// carries a top-level timing object so TTFT survives failure paths where response is absent.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordGenerateTextDebug, recordStreamTextDebug } from "../src/model/runner-debug.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";

interface RecordedTiming {
  stream: boolean;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
}

describe("model-io record stream timing", () => {
  let debugDir: string;

  beforeEach(async () => {
    debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-timing-"));
  });

  afterEach(async () => {
    await rm(debugDir, { recursive: true, force: true });
  });

  const resolved = {
    providerId: "test-provider",
    modelId: "test-model",
    baseURL: "https://api.example.test",
    headers: {},
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;

  const settledResult = {
    request: Promise.resolve({ body: { model: "test-model" } }),
    response: Promise.resolve({ id: "resp-1", headers: {}, modelId: "test-model" }),
  } as unknown as AiSdkStreamTextResult;

  async function readRecord(
    sessionId: string,
  ): Promise<{ timing?: RecordedTiming; durationMs?: number }> {
    const files = await readdir(debugDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(debugDir, files[0]!), "utf8");
    const record = JSON.parse(content.trim()) as { timing?: RecordedTiming; durationMs?: number };
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    return record;
  }

  function buildRequest(sessionId: string): AiSdkModelTextRequest {
    return {
      messages: [],
      metadata: { sessionId },
    } as unknown as AiSdkModelTextRequest;
  }

  it("a successful stream records all three values, each at most durationMs", async () => {
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      isDev: true,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      options: { messages: [] } as unknown as AiSdkStreamTextOptions,
      recordModelIO: true,
      request: buildRequest("sess-timing-success"),
      requestId: "req-timing-success",
      resolved,
      result: settledResult,
      // Backdate the attempt so durationMs comfortably covers the measured milestones.
      startedAt: Date.now() - 3_000,
      timing: {
        timeToFirstProviderEventMs: 412.4,
        timeToFirstContentMs: 655,
        timeToFirstTextMs: 1_890,
      },
    });

    const record = await readRecord("sess-timing-success");
    expect(record.timing).toEqual({
      stream: true,
      timeToFirstProviderEventMs: 412,
      timeToFirstContentMs: 655,
      timeToFirstTextMs: 1890,
    });
    for (const value of Object.values(record.timing ?? {})) {
      if (typeof value === "number") {
        expect(value).toBeLessThanOrEqual(record.durationMs!);
      }
    }
  });

  it("a stream failing after the first event records only the values measured so far", async () => {
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      error: new Error("mid-stream failure"),
      isDev: true,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      options: { messages: [] } as unknown as AiSdkStreamTextOptions,
      recordModelIO: true,
      request: buildRequest("sess-timing-partial"),
      requestId: "req-timing-partial",
      resolved,
      result: settledResult,
      startedAt: Date.now(),
      timing: { timeToFirstProviderEventMs: 120 },
    });

    const record = await readRecord("sess-timing-partial");
    expect(record.timing).toEqual({ stream: true, timeToFirstProviderEventMs: 120 });
    // Values never reached are omitted, never null or 0.
    expect(record.timing).not.toHaveProperty("timeToFirstContentMs");
    expect(record.timing).not.toHaveProperty("timeToFirstTextMs");
  });

  it("a stream failing before any event records { stream: true } only", async () => {
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      error: new Error("connect failed before any provider event"),
      isDev: true,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      options: { messages: [] } as unknown as AiSdkStreamTextOptions,
      recordModelIO: true,
      request: buildRequest("sess-timing-empty"),
      requestId: "req-timing-empty",
      resolved,
      startedAt: Date.now(),
    });

    const record = await readRecord("sess-timing-empty");
    expect(record.timing).toEqual({ stream: true });
  });

  it("a generate call records { stream: false }", async () => {
    await recordGenerateTextDebug({
      attempt: 1,
      debugDir,
      isDev: true,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      options: { messages: [] } as unknown as AiSdkGenerateTextOptions,
      recordModelIO: true,
      request: buildRequest("sess-timing-generate"),
      requestId: "req-timing-generate",
      resolved,
      startedAt: Date.now(),
    });

    const record = await readRecord("sess-timing-generate");
    expect(record.timing).toEqual({ stream: false });
  });

  it("a production record keeps timing after trimming", async () => {
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      isDev: false,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      options: { messages: [] } as unknown as AiSdkStreamTextOptions,
      recordModelIO: true,
      request: buildRequest("sess-timing-production"),
      requestId: "req-timing-production",
      resolved,
      result: settledResult,
      startedAt: Date.now(),
      timing: { timeToFirstProviderEventMs: 50, timeToFirstContentMs: 90 },
    });

    const record = await readRecord("sess-timing-production");
    expect(record.timing).toEqual({
      stream: true,
      timeToFirstProviderEventMs: 50,
      timeToFirstContentMs: 90,
    });
  });
});
