import { describe, expect, it } from "vitest";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import {
  OFF_PEAK_QUEUE_WAIT_CAP_MS,
  OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
  OFF_PEAK_TICKET_EXPIRED_MARKER,
  resolveOffPeakFailureDecision,
} from "../src/model/offpeak-retry.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";
import { ModelErrorCode, ModelFailureReason, ModelRetryReason } from "@zcode/contracts";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const TEST_QUEUE_PROVIDER_ID = "configured-queue-provider";

// Off-peak queueing protocol (D24/D26): 429/3105 is exempt from the retry budget and probes without limit;
// a 400/3102 stable marker triggers resumption. The semantics only apply to idle plan providers; ordinary
// providers keep the existing budget — both sides need regression proof.

function offPeakRegistryConfig() {
  return {
    providers: {
      [TEST_QUEUE_PROVIDER_ID]: {
        kind: "anthropic" as const,
        apiKey: "jwt-token",
        baseURL: "http://127.0.0.1:9/api/v1/off-peak/anthropic",
        headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
      },
      "plain-provider": {
        kind: "anthropic" as const,
        apiKey: "key",
        baseURL: "http://127.0.0.1:9/plain",
      },
    },
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function queue429(retryAfterSeconds: number): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: "3105",
    providerId: TEST_QUEUE_PROVIDER_ID,
    providerKind: "anthropic",
    providerMessage: "model concurrency saturated",
    responseHeaders: { "retry-after": String(retryAfterSeconds) },
    responseStatus: 429,
    statusCode: 429,
  });
}

function ticketUnavailable(code = "3102"): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: code,
    providerId: TEST_QUEUE_PROVIDER_ID,
    providerKind: "anthropic",
    providerMessage: "ticket unavailable",
    responseStatus: 400,
    statusCode: 400,
  });
}

function makeAdapter(runtime: AiSdkModelRuntime, maxAttempts: number) {
  return new AiSdkModelAdapter({
    registry: new TestProviderConfigFixture(offPeakRegistryConfig()),
    retry: { baseDelayMs: 0, jitter: false, maxAttempts },
    runtime,
  });
}

describe("off-peak 排队重试（generate 路径）", () => {
  it("429/3105 豁免重试预算：失败次数远超 maxAttempts 仍继续探测直至准入", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        if (calls <= 4) throw queue429(0); // retry-after 0s: test with zero wait
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = makeAdapter(runtime, 2); // budget of only 2 attempts
    const result = await executeAdapterGenerateText(adapter, {
      providerId: TEST_QUEUE_PROVIDER_ID as never,
      modelId: "GLM-5.2" as never,
      accountMode: "off-peak",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(result.text).toBe("done");
    expect(calls).toBe(5); // 4 queued + 1 success > maxAttempts=2
  });

  it("排队等待不吞真实错误预算：排队探测后出现真实 5xx 仍有完整预算", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        if (calls <= 3) throw queue429(0); // 3 queued (if counted against the budget, maxAttempts=3 would already be exhausted)
        if (calls === 4) {
          throw Object.assign(new Error("upstream 500"), {
            isRetryable: true,
            statusCode: 500,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = makeAdapter(runtime, 3);
    const result = await executeAdapterGenerateText(adapter, {
      providerId: TEST_QUEUE_PROVIDER_ID as never,
      modelId: "GLM-5.2" as never,
      accountMode: "off-peak",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(result.text).toBe("done");
    expect(calls).toBe(5);
  });

  it("400/3102 立即以稳定标记落败（触发 desktop 续跑，非普通失败）", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw ticketUnavailable();
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = makeAdapter(runtime, 5);
    const error = await executeAdapterGenerateText(adapter, {
      providerId: TEST_QUEUE_PROVIDER_ID as never,
      modelId: "GLM-5.2" as never,
      accountMode: "off-peak",
      messages: [{ role: "user", content: "ping" }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(OFF_PEAK_TICKET_EXPIRED_MARKER);
  });

  it("回归：普通 provider 的 429 仍受 maxAttempts 预算约束", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        throw Object.assign(new Error("rate limited"), {
          isRetryable: true,
          statusCode: 429,
          responseHeaders: { "retry-after": "0" },
        });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = makeAdapter(runtime, 2);
    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "plain-provider" as never,
        modelId: "some-model" as never,
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(2); // budget as usual
  });
});

describe("off-peak 排队重试（stream 路径）", () => {
  it("SSE 首块前的 429/3105 豁免预算重试，准入后正常出流", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        calls += 1;
        if (calls <= 3) {
          return {
            // eslint-disable-next-line require-yield -- simulate the stream throwing as soon as it starts
            fullStream: (async function* () {
              throw queue429(0);
            })(),
          } as never;
        }
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "done" };
            yield { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) };
          })(),
        } as never;
      },
    };
    const adapter = makeAdapter(runtime, 2);
    const events: unknown[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: TEST_QUEUE_PROVIDER_ID as never,
      modelId: "GLM-5.2" as never,
      accountMode: "off-peak",
      messages: [{ role: "user", content: "ping" }],
    })) {
      events.push(event);
    }
    expect(calls).toBe(4); // 3 queued + 1 success > maxAttempts=2
    expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
  });

  it("stream 3102 落败信息携带续跑标记", async () => {
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
            // eslint-disable-next-line require-yield -- simulate the stream throwing as soon as it starts
          fullStream: (async function* () {
            throw ticketUnavailable();
          })(),
        } as never;
      },
    };
    const adapter = makeAdapter(runtime, 5);
    const iterate = async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: TEST_QUEUE_PROVIDER_ID as never,
        modelId: "GLM-5.2" as never,
        accountMode: "off-peak",
        messages: [{ role: "user", content: "ping" }],
      })) {
        // drain
      }
    };
    const error = await iterate().catch((e: unknown) => e);
    expect((error as Error).message).toContain(OFF_PEAK_TICKET_EXPIRED_MARKER);
  });
});

describe("resolveOffPeakFailureDecision 纯函数", () => {
  const baseFailure: ClassifiedModelFailure = {
    code: ModelErrorCode.ModelRateLimited,
    message: "rate limited",
    reason: ModelFailureReason.RateLimited,
    retryReason: ModelRetryReason.RateLimited,
    retryable: true,
    retryAfterMs: undefined,
    statusCode: 429,
  };

  it("钳制：min(Retry-After, 5min)；缺省 60s", () => {
    expect(
      resolveOffPeakFailureDecision({
        offPeak: true,
        failure: { ...baseFailure, retryAfterMs: 120_000 },
        error: queue429(120),
      }),
    ).toEqual({ kind: "queued", delayMs: 120_000 });
    // An hour-scale Retry-After is clamped to 5 minutes (the existing MAX_REASONABLE is a rejection
    // threshold; here it must be a clamp, D24)
    expect(
      resolveOffPeakFailureDecision({
        offPeak: true,
        failure: { ...baseFailure, retryAfterMs: 3_600_000 },
        error: queue429(3600),
      }),
    ).toEqual({ kind: "queued", delayMs: OFF_PEAK_QUEUE_WAIT_CAP_MS });
    expect(
      resolveOffPeakFailureDecision({
        offPeak: true,
        failure: baseFailure,
        error: queue429(0),
      }),
    ).toEqual({ kind: "queued", delayMs: OFF_PEAK_QUEUE_WAIT_DEFAULT_MS });
  });

  it("未声明 off-peak-queue 协议一律 null（零影响）", () => {
    expect(
      resolveOffPeakFailureDecision({
        offPeak: false,
        failure: baseFailure,
        error: queue429(10),
      }),
    ).toBeNull();
  });

  it("兼容滚动发布期间旧网关的 3001 票据不可用码", () => {
    expect(
      resolveOffPeakFailureDecision({
        offPeak: true,
        failure: { ...baseFailure, statusCode: 400 },
        error: ticketUnavailable("3001"),
      }),
    ).toEqual({ kind: "ticketExpired" });
  });
});
