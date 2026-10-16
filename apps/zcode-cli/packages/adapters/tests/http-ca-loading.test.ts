import http from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { rootCertificates } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeHttpClientAdapter } from "../src/http/index.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));

afterEach(() => {
  vi.mocked(readFile).mockReset();
  vi.useRealTimers();
});

describe.each(["fetch", "HttpClientPort"] as const)("%s CA loading", (client) => {
  function createRequest(url: string) {
    if (client === "fetch") {
      const fetch = createNetworkProxyFetch({ caCertFile: "/test/ca.pem" });
      return async (signal?: AbortSignal) => (await fetch(url, { signal })).text();
    }
    const adapter = createNodeHttpClientAdapter({ caCertFile: "/test/ca.pem" });
    return async (signal?: AbortSignal) => {
      const response = await adapter.request({ url }, { signal });
      return new TextDecoder().decode(response.body);
    };
  }

  it("cancels one wait without cancelling the shared read or another request", async () => {
    let finishRead!: (value: Buffer) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const pendingRead = new Promise<Buffer>((resolve) => {
      finishRead = resolve;
    });
    vi.mocked(readFile).mockImplementationOnce(() => {
      readStarted();
      return pendingRead;
    });
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const request = createRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const abort = new AbortController();
    let failure: unknown;
    const first = request(abort.signal).catch((error) => {
      failure = error;
    });
    const second = request();
    try {
      await started;
      abort.abort(new Error("cancel CA wait"));
      await setImmediate();
      expect(failure).toMatchObject({ message: "cancel CA wait" });
      expect(readFile).toHaveBeenCalledTimes(1);
      finishRead(Buffer.from(rootCertificates[0]!));
      await expect(second).resolves.toBe("ok");
      await expect(request()).resolves.toBe("ok");
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      finishRead(Buffer.from(rootCertificates[0]!));
      await Promise.allSettled([first, second]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retries a failed read on the next request", async () => {
    vi.mocked(readFile)
      .mockRejectedValueOnce(
        Object.assign(new Error("CA temporarily unavailable"), { code: "ENOENT" }),
      )
      .mockResolvedValueOnce(Buffer.from(rootCertificates[0]!));
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const request = createRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    try {
      await expect(request()).rejects.toThrow("CA temporarily unavailable");
      await expect(request()).resolves.toBe("ok");
      expect(readFile).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("HttpClientPort times out while the CA read is pending", async () => {
  let finishRead!: (value: Buffer) => void;
  const pendingRead = new Promise<Buffer>((resolve) => {
    finishRead = resolve;
  });
  vi.mocked(readFile).mockReturnValueOnce(pendingRead);
  vi.useFakeTimers();
  const adapter = createNodeHttpClientAdapter({ caCertFile: "/test/ca.pem", timeoutMs: 50 });
  let failure: unknown;
  const result = adapter.request({ url: "http://127.0.0.1:1/" }).catch((error) => {
    failure = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(failure).toMatchObject({ code: "timeout" });
  } finally {
    vi.useRealTimers();
    finishRead(Buffer.from(rootCertificates[0]!));
    await result;
  }
});
