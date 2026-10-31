import { describe, expect, it, vi } from "vitest";
import { detectOllama, normalizeOllamaBaseUrl } from "../src/model-provider/ollamaDetection.js";

// specs/ollama-local-provider.md "Detector".
type Route = (init?: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const body = route(init);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
}

const ROOT = "http://127.0.0.1:11434";

describe("normalizeOllamaBaseUrl", () => {
  it("defaults to the IPv4 loopback address", () => {
    expect(normalizeOllamaBaseUrl(undefined)).toBe(ROOT);
    expect(normalizeOllamaBaseUrl("  ")).toBe(ROOT);
  });

  it("strips trailing slashes and /v1 and adds a missing scheme (OL7)", () => {
    expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/v1/")).toBe(ROOT);
    expect(normalizeOllamaBaseUrl("gpu-box:11434")).toBe("http://gpu-box:11434");
    expect(normalizeOllamaBaseUrl("https://host/ollama/v1")).toBe("https://host/ollama");
  });

  it("rejects non-http addresses", () => {
    expect(normalizeOllamaBaseUrl("ftp://host")).toBeNull();
    expect(normalizeOllamaBaseUrl("http://")).toBeNull();
  });
});

describe("detectOllama", () => {
  it("lists models with their capabilities and context length (OL2, OL3)", async () => {
    const fetch = fakeFetch({
      [`${ROOT}/api/version`]: () => ({ version: "0.40.11" }),
      [`${ROOT}/api/tags`]: () => ({
        models: [
          { name: "qwen3:8b", details: { parameter_size: "8.2B" } },
          { name: "phonon:latest", details: {} },
        ],
      }),
      [`${ROOT}/api/show`]: (init) => {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        return model === "qwen3:8b"
          ? { capabilities: ["completion", "tools"], model_info: { "qwen3.context_length": 40960 } }
          : { capabilities: ["speech"], model_info: {} };
      },
    });

    const result = await detectOllama({ baseUrl: `${ROOT}/v1` }, { fetch });

    expect(result).toEqual({
      reachable: true,
      baseUrl: ROOT,
      version: "0.40.11",
      models: [
        {
          name: "qwen3:8b",
          parameterSize: "8.2B",
          capabilities: ["completion", "tools"],
          contextLength: 40960,
        },
        { name: "phonon:latest", capabilities: ["speech"] },
      ],
    });
  });

  it("keeps a model with unknown details when /api/show fails or reports no capabilities", async () => {
    const fetch = fakeFetch({
      [`${ROOT}/api/version`]: () => ({ version: "0.1.0" }),
      [`${ROOT}/api/tags`]: () => ({ models: [{ name: "old" }, { name: "broken" }] }),
      [`${ROOT}/api/show`]: (init) =>
        (JSON.parse(String(init?.body)) as { model: string }).model === "old"
          ? { model_info: {} }
          : new Error("socket hang up"),
    });

    const result = await detectOllama({}, { fetch });

    expect(result.reachable && result.models).toEqual([{ name: "old" }, { name: "broken" }]);
  });

  it("reports an unreachable server with the error code (OL1)", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const fetch = vi.fn(async () => {
      throw refused;
    }) as unknown as typeof globalThis.fetch;

    expect(await detectOllama({}, { fetch })).toEqual({
      reachable: false,
      baseUrl: ROOT,
      error: "ECONNREFUSED",
    });
  });

  it("reports a timeout", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof globalThis.fetch;

    expect(await detectOllama({}, { fetch })).toMatchObject({
      reachable: false,
      error: "timed out",
    });
  });

  it("refuses an invalid address without any request", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await detectOllama({ baseUrl: "ftp://x" }, { fetch })).toMatchObject({
      reachable: false,
      error: "invalid address",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
