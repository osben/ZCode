const BOT_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export interface BotProviderJsonResponse<T> {
  ok: boolean;
  status: number;
  payload: T | undefined;
  responseLogId?: string;
}

export interface BotProviderResponse {
  ok: boolean;
  status: number;
}

async function runBotProviderRequest<T>(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    onAbort();
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Bot provider request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    // Reason for fix: receiving response headers does not mean the request is complete. Consume the response body under the same AbortSignal and deadline,
    // or the server can stall after sending headers and block the Bot actor queue indefinitely.
    return await consume(response);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Third-party Bot APIs may not terminate hung requests themselves. Bound all callback ACKs and outbound messages,
 * or one request can occupy the actor's serial queue and prevent later permission, Q&A, and plan-approval steps.
 */
export async function fetchBotProvider(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderResponse> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    // Bug fix: fetch() completes when response headers arrive; returning Response directly would clear the deadline too early.
    // Telegram callers need only the status, so consume the response body under the controlled signal and return a lightweight result.
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status };
  });
}

export async function fetchBotProviderJson<T>(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderJsonResponse<T>> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    const text = await response.text();
    let payload: T | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as T;
      } catch (error) {
        if (response.ok) {
          throw error;
        }
      }
    }
    const responseLogId = response.headers.get("x-tt-logid") ?? undefined;
    return { ok: response.ok, status: response.status, payload, responseLogId };
  });
}
