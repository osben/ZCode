import { describe, expect, it } from "vitest";
import {
  attachSiwcUsageToFinishEvent,
  attachSiwcUsageToTextResult,
  createSiwcUsageCaptureFetch,
  readSiwcUsageSnapshotFromHeaders,
  type SiwcUsageCapture,
} from "../src/model/siwc-usage-capture.js";

function createHeadersFetch(headers: Record<string, string>): typeof fetch {
  return async () => new Response("{}", { status: 200, headers });
}

describe("siwc-usage-capture", () => {
  it("captures the full primary + secondary triplets", async () => {
    const capture: SiwcUsageCapture = {
      providerId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
    };
    const fetchFn = createSiwcUsageCaptureFetch(
      createHeadersFetch({
        "x-codex-primary-used-percent": "42.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "2026-10-15T18:00:00Z",
        "x-codex-secondary-used-percent": "7",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "2026-10-19T00:00:00Z",
      }),
      capture,
    );
    const response = await fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(capture.snapshot).toEqual({
      primary: {
        usedPercent: 42.5,
        windowMinutes: 300,
        resetsAt: "2026-10-15T18:00:00Z",
      },
      secondary: {
        usedPercent: 7,
        windowMinutes: 10080,
        resetsAt: "2026-10-19T00:00:00Z",
      },
    });
  });

  it("captures a percent-only primary window (partial headers)", () => {
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({ "x-codex-primary-used-percent": "13" }),
      ),
    ).toEqual({ primary: { usedPercent: 13 } });
  });

  it("skips a window whose used-percent is missing", () => {
    // window-minutes + reset-at without the required percent member must not fabricate a window.
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": "2026-10-15T18:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  it("ignores secondary-only readings (primary identifies the snapshot)", () => {
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({
          "x-codex-secondary-used-percent": "7",
          "x-codex-secondary-window-minutes": "10080",
        }),
      ),
    ).toBeNull();
  });

  it("returns null when no usage headers exist", () => {
    expect(readSiwcUsageSnapshotFromHeaders(new Headers({ "content-type": "text/event-stream" }))).toBeNull();
  });

  it("rejects garbage numeric values tolerantly", () => {
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({ "x-codex-primary-used-percent": "not-a-number" }),
      ),
    ).toBeNull();
    expect(
      readSiwcUsageSnapshotFromHeaders(new Headers({ "x-codex-primary-used-percent": "NaN" })),
    ).toBeNull();
    // Out-of-range percents are garbage, not clamped.
    expect(
      readSiwcUsageSnapshotFromHeaders(new Headers({ "x-codex-primary-used-percent": "140" })),
    ).toBeNull();
    expect(
      readSiwcUsageSnapshotFromHeaders(new Headers({ "x-codex-primary-used-percent": "-1" })),
    ).toBeNull();
    // A garbage window-minutes is dropped while the percent stays reportable.
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({
          "x-codex-primary-used-percent": "20",
          "x-codex-primary-window-minutes": "soon",
        }),
      ),
    ).toEqual({ primary: { usedPercent: 20 } });
  });

  it("rejects empty percentages while preserving an explicit zero", () => {
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({ "x-codex-primary-used-percent": "" }),
      ),
    ).toBeNull();
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({ "x-codex-primary-used-percent": "   " }),
      ),
    ).toBeNull();
    expect(
      readSiwcUsageSnapshotFromHeaders(
        new Headers({ "x-codex-primary-used-percent": "0" }),
      ),
    ).toEqual({ primary: { usedPercent: 0 } });
  });

  it("keeps the latest snapshot across responses and leaves capture untouched without headers", async () => {
    const capture: SiwcUsageCapture = {
      providerId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
    };
    let headers: Record<string, string> = { "x-codex-primary-used-percent": "10" };
    const fetchFn = createSiwcUsageCaptureFetch(
      async () => new Response("{}", { status: 200, headers }),
      capture,
    );
    await fetchFn("https://api.test");
    expect(capture.snapshot).toEqual({ primary: { usedPercent: 10 } });

    headers = {};
    await fetchFn("https://api.test");
    // Absent headers never clear a previously captured reading.
    expect(capture.snapshot).toEqual({ primary: { usedPercent: 10 } });

    headers = { "x-codex-primary-used-percent": "80" };
    await fetchFn("https://api.test");
    expect(capture.snapshot).toEqual({ primary: { usedPercent: 80 } });
  });

  it("attaches the captured snapshot to a finish event usage", () => {
    const capture: SiwcUsageCapture = {
      providerId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
    };
    expect(attachSiwcUsageToFinishEvent({ type: "start" }, capture)).toEqual({ type: "start" });

    capture.snapshot = { primary: { usedPercent: 55 } };
    const finish = attachSiwcUsageToFinishEvent(
      { type: "finish", finishReason: "stop", usage: { inputTokens: 5 } },
      capture,
    );
    expect(finish).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        providerRateLimits: { primary: { usedPercent: 55 } },
        providerRateLimitProviderId: capture.providerId,
      },
    });
  });

  it("attaches the captured snapshot to a text result usage", () => {
    const capture: SiwcUsageCapture = {
      providerId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
    };
    const untouched = { text: "hi", finishReason: "stop", usage: { totalTokens: 3 } };
    expect(attachSiwcUsageToTextResult(untouched, capture)).toBe(untouched);

    capture.snapshot = { primary: { usedPercent: 1 } };
    expect(attachSiwcUsageToTextResult(untouched, capture)).toEqual({
      text: "hi",
      finishReason: "stop",
      usage: {
        totalTokens: 3,
        providerRateLimits: { primary: { usedPercent: 1 } },
        providerRateLimitProviderId: capture.providerId,
      },
    });
  });
});
