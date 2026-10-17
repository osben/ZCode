import { createServer, type Server } from "node:http";
import { SIWC_CODEX_CALLBACK_PATH } from "./siwcCodexWire.js";
import { SiwcOAuthError } from "./siwcOAuth.js";

export interface CodexLoopbackHandle {
  callbackUrl: string;
  isSettled: () => boolean;
  server: Server;
  completion: Promise<{ code: string }>;
}

/**
 * Loopback listener for the codex-flavor usage grant. The callback shape is the Codex CLI's
 * registered `http://localhost:{port}/auth/callback` — byte-identical to it, since the public
 * client only accepts that registered redirect. Tests pass port 0 (ephemeral); production
 * pins the codex port.
 */
export function listenForCodexCallback(state: string, port: number): Promise<CodexLoopbackHandle> {
  let settleCompletion: (completion: { code: string }) => void = () => undefined;
  let rejectCompletion: (reason: unknown) => void = () => undefined;
  let settled = false;
  const completion = new Promise<{ code: string }>((resolve, reject) => {
    settleCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = createServer((request, response) => {
    const respond = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== SIWC_CODEX_CALLBACK_PATH) {
        respond(404, "Unknown callback path.");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respond(400, "Authorization state mismatch.");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        respond(400, "Authorization failed. You may close this window and return to the app.");
        if (!settled) {
          settled = true;
          rejectCompletion(
            new SiwcOAuthError({
              error: oauthError,
              ...(url.searchParams.get("error_description")
                ? { errorDescription: url.searchParams.get("error_description")! }
                : {}),
            }),
          );
        }
        return;
      }
      const code = url.searchParams.get("code")?.trim();
      if (!code) {
        respond(400, "Authorization callback is missing a code.");
        return;
      }
      respond(200, "Usage linking successful! You may close this window and return to the app.");
      if (!settled) {
        settled = true;
        settleCompletion({ code });
      }
    } catch (error) {
      respond(500, "Authorization failed.");
      if (!settled) {
        settled = true;
        rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  return new Promise<CodexLoopbackHandle>((resolve, reject) => {
    const rejectListenError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            "Usage link callback port is busy. Close any other authorization flow and retry.",
          ),
        );
        return;
      }
      reject(error);
    };
    server.once("error", rejectListenError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListenError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to resolve the usage link callback address."));
        return;
      }
      const callbackPort = port === 0 ? address.port : port;
      resolve({
        callbackUrl: `http://localhost:${callbackPort}${SIWC_CODEX_CALLBACK_PATH}`,
        isSettled: () => settled,
        server,
        completion,
      });
    });
  });
}

export async function closeCodexLoopbackServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    // Stop accepting callbacks before dropping the browser's remaining keep-alive socket.
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
