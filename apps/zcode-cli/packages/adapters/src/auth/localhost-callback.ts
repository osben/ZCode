import { createServer, type ServerResponse } from "node:http";
import {
  buildOAuthCallbackPage,
  respondWithOAuthCallbackPage,
  type OAuthCallbackOutcome,
} from "@zcode/shared/node";
import type { AddressInfo } from "node:net";

const LOCALHOST = "127.0.0.1";

/** Stable error code returned when the authorization server sends `error` per RFC 6749 §4.1.2.1. */
export const MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE = "MCP_OAUTH_CALLBACK_DENIED";

export interface McpOAuthCallbackDeniedError extends Error {
  code: typeof MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  oauthError: string;
  oauthErrorDescription?: string;
}

function createCallbackDeniedError(
  oauthError: string,
  oauthErrorDescription: string | null,
): McpOAuthCallbackDeniedError {
  // Do not branch on error text; callers distinguish user denial from timeout using the structured code/oauthError fields.
  const error = new Error(
    `OAuth authorization was rejected by the authorization server: ${oauthError}`,
  ) as McpOAuthCallbackDeniedError;
  error.code = MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  error.oauthError = oauthError;
  if (oauthErrorDescription) error.oauthErrorDescription = oauthErrorDescription;
  return error;
}

export interface LocalhostOAuthCallback {
  code: string;
  url: string;
  /**
   * Issued client id when the authorization server registers a dynamic client on first
   * sign-in (SIWC). Absent on re-auth callbacks and for providers without dynamic
   * registration; the full `url` remains available for other extra params.
   */
  clientId?: string;
}

export interface LocalhostOAuthCallbackServer {
  callbackPath: string;
  callbackUrl: string;
  close(): Promise<void>;
  waitForCallback(): Promise<LocalhostOAuthCallback>;
}

export async function createLocalhostOAuthCallbackServer(input: {
  callbackPath: string;
  state: string;
}): Promise<LocalhostOAuthCallbackServer> {
  let resolveCallback: (value: LocalhostOAuthCallback) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  let settled = false;
  const callbackPromise = new Promise<LocalhostOAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${LOCALHOST}`);
      if (requestUrl.pathname !== input.callbackPath) {
        writePage(response, 404, "invalid");
        return;
      }

      // A state mismatch used to reject this transaction's callback promise. Concurrent authorization transactions,
      // stale authorization URLs left in the browser, or prefetch requests can all reach this listener; one unknown
      // state could prevent the correct callback from succeeding later. Now return 400 and keep waiting for this transaction's state.
      const state = requestUrl.searchParams.get("state") ?? "";
      if (state !== input.state) {
        writePage(response, 400, "invalid");
        return;
      }

      // A matching state confirms this is the authorization response for this transaction. When the user denies access,
      // the server returns error=access_denied; previously we waited for the caller to time out, but now settle immediately.
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        writePage(response, 400, "denied", requestUrl.searchParams.get("error_description"));
        if (!settled) {
          settled = true;
          rejectCallback(
            createCallbackDeniedError(oauthError, requestUrl.searchParams.get("error_description")),
          );
        }
        return;
      }

      const code =
        requestUrl.searchParams.get("authCode") ?? requestUrl.searchParams.get("code") ?? "";
      if (!code) {
        // A matching state with neither code nor error is an invalid response, so this transaction cannot succeed. Fail
        // immediately instead of consuming the rest of the authorization window.
        writePage(response, 400, "invalid");
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth callback is missing an authorization code."));
        }
        return;
      }

      writePage(response, 200, "success");
      if (!settled) {
        settled = true;
        // Extra params (SIWC returns the issued client_id and iss) are tolerated and only the
        // client_id is surfaced explicitly; everything else stays available via `url`.
        const clientId = requestUrl.searchParams.get("client_id") ?? "";
        resolveCallback({
          code,
          url: requestUrl.toString(),
          ...(clientId ? { clientId } : {}),
        });
      }
    } catch (error) {
      writePage(response, 500, "failed");
      if (!settled) {
        settled = true;
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("Unable to resolve localhost callback server address.");
  }

  const callbackUrl = `http://${LOCALHOST}:${address.port}${input.callbackPath}`;
  return {
    callbackPath: input.callbackPath,
    callbackUrl,
    close: async () => {
      await closeServer(server);
    },
    waitForCallback: () => callbackPromise,
  };
}

function writePage(
  response: ServerResponse,
  status: number,
  outcome: OAuthCallbackOutcome,
  detail?: string | null,
): void {
  respondWithOAuthCallbackPage(
    response,
    status,
    buildOAuthCallbackPage(outcome, {
      flow: "sign-in",
      surface: "cli",
      ...(detail ? { detail } : {}),
    }),
  );
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}
