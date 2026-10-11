import type {
  CompiledModelOptionMaps,
  JsonObject,
  ModelOptionValues,
} from "@zcode/model-option-map";

type ProviderFetch = typeof globalThis.fetch;

export interface RawRequestBodyCapture {
  body?: JsonObject;
}

export function createModelOptionMapFetch(input: {
  readonly capture?: RawRequestBodyCapture;
  readonly fetch: ProviderFetch;
  readonly maps: CompiledModelOptionMaps;
  readonly values: ModelOptionValues;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    const body = parseJsonObject(bodyText);
    const patched = input.maps.apply(body, input.values);
    if (input.capture) input.capture.body = patched;
    const patchedBody = JSON.stringify(patched);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return input.fetch(request, { ...init, body: patchedBody });
  };
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // The Option Map is the sole authority for request fields such as reasoning/max-output. If the
  // SDK changes to a non-text Body and silently skips the patch, the request would still be sent
  // without those options; therefore, fail closed whenever a Body is present.
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("Model option maps require a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

function parseJsonObject(body: string): JsonObject {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model option maps require a JSON object request body.");
  }
  return parsed as JsonObject;
}
