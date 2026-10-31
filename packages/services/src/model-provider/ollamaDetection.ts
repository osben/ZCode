/**
 * Read-only probe of an Ollama server for Model Settings (specs/ollama-local-provider.md "Detector").
 * It runs on the host that owns the workspace, so a remote workspace probes its own machine. It never
 * writes settings or files; the Settings pane owns the provider sync.
 */
import { createServiceLogger } from "../logger/serviceLogger.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export interface OllamaDetectInput {
  /** Server address as typed; defaults to {@link OLLAMA_DEFAULT_BASE_URL}. */
  readonly baseUrl?: string;
}

export interface OllamaModelSummary {
  readonly name: string;
  readonly parameterSize?: string;
  readonly contextLength?: number;
  /** Absent when the server does not report capabilities (older Ollama): unknown, not "none". */
  readonly capabilities?: readonly string[];
}

export type OllamaDetectionResult =
  | {
      readonly reachable: true;
      readonly baseUrl: string;
      readonly version: string;
      readonly models: readonly OllamaModelSummary[];
    }
  | { readonly reachable: false; readonly baseUrl: string; readonly error: string };

export interface OllamaDetectionDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

const VERSION_TIMEOUT_MS = 2_000;
const TAGS_TIMEOUT_MS = 3_000;
const SHOW_TIMEOUT_MS = 3_000;
const SHOW_CONCURRENCY = 4;

/**
 * The server root of a typed address: trimmed, a missing scheme becomes `http://`, and trailing `/` and
 * `/v1` are removed (users paste the OpenAI-compatible URL). Returns null for an address that is not a URL.
 */
export function normalizeOllamaBaseUrl(input: string | undefined): string | null {
  const trimmed = (input ?? "").trim() || OLLAMA_DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

async function getJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Details of one model from `/api/show`; empty when the server does not answer for it. */
async function showModel(
  fetchImpl: typeof globalThis.fetch,
  root: string,
  name: string,
): Promise<Pick<OllamaModelSummary, "contextLength" | "capabilities">> {
  try {
    const body = asRecord(
      await getJson(fetchImpl, `${root}/api/show`, SHOW_TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name }),
      }),
    );
    if (!body) return {};
    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((value): value is string => typeof value === "string")
      : undefined;
    const modelInfo = asRecord(body.model_info);
    const contextLength = modelInfo
      ? Object.entries(modelInfo).find(
          ([key, value]) => key.endsWith(".context_length") && typeof value === "number",
        )?.[1]
      : undefined;
    return {
      ...(capabilities ? { capabilities } : {}),
      ...(typeof contextLength === "number" && contextLength > 0 ? { contextLength } : {}),
    };
  } catch {
    return {};
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    const cause = asRecord((error as { cause?: unknown }).cause);
    if (typeof cause?.code === "string") return cause.code;
    return error.message;
  }
  return String(error);
}

export async function detectOllama(
  input: OllamaDetectInput = {},
  dependencies: OllamaDetectionDependencies = {},
): Promise<OllamaDetectionResult> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  // Created per call: the renderer imports this module through `@zcode/services` for its constants and has no
  // `process`, which the service logger reads.
  const log = createServiceLogger("ollama-detection");
  const root = normalizeOllamaBaseUrl(input.baseUrl);
  if (root === null) {
    return { reachable: false, baseUrl: input.baseUrl?.trim() ?? "", error: "invalid address" };
  }
  try {
    const versionBody = asRecord(
      await getJson(fetchImpl, `${root}/api/version`, VERSION_TIMEOUT_MS),
    );
    const version = typeof versionBody?.version === "string" ? versionBody.version : "";
    const tags = asRecord(await getJson(fetchImpl, `${root}/api/tags`, TAGS_TIMEOUT_MS));
    const listed = Array.isArray(tags?.models) ? tags.models : [];
    const entries = listed.flatMap((raw) => {
      const model = asRecord(raw);
      const name = typeof model?.name === "string" ? model.name.trim() : "";
      if (!name) return [];
      const parameterSize = asRecord(model?.details)?.parameter_size;
      return [
        {
          name,
          ...(typeof parameterSize === "string" && parameterSize ? { parameterSize } : {}),
        },
      ];
    });
    const details = await mapLimited(entries, SHOW_CONCURRENCY, (entry) =>
      showModel(fetchImpl, root, entry.name),
    );
    const models = entries.map((entry, index) => ({ ...entry, ...details[index] }));
    log.info(undefined, "Ollama detection finished", {
      reachable: true,
      modelCount: models.length,
      defaultAddress: root === OLLAMA_DEFAULT_BASE_URL,
    });
    return { reachable: true, baseUrl: root, version, models };
  } catch (error) {
    log.info(undefined, "Ollama detection finished", {
      reachable: false,
      defaultAddress: root === OLLAMA_DEFAULT_BASE_URL,
    });
    return { reachable: false, baseUrl: root, error: describeError(error) };
  }
}
