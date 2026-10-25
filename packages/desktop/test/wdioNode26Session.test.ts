import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { remote } from "webdriverio";

describe("WebDriverIO Node.js runtime compatibility", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("creates and closes a session against a local WebDriver endpoint", async () => {
    const requests: string[] = [];
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");

        if (request.method === "POST" && request.url === "/session") {
          response.end(
            JSON.stringify({
              value: {
                sessionId: "mock-session",
                capabilities: { browserName: "mock" },
              },
            }),
          );
          return;
        }

        if (request.method === "GET" && request.url === "/session/mock-session/window") {
          response.end(JSON.stringify({ value: "mock-window" }));
          return;
        }

        if (request.method === "DELETE" && request.url === "/session/mock-session") {
          response.end(JSON.stringify({ value: null }));
          return;
        }

        response.statusCode = 404;
        response.end(
          JSON.stringify({
            value: { error: "unknown command", message: "unexpected route" },
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local WebDriver endpoint did not bind to a TCP port");
    }

    const browser = await remote({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/",
      capabilities: { browserName: "mock" },
      logLevel: "error",
      connectionRetryCount: 0,
    });

    expect(browser.sessionId).toBe("mock-session");
    await browser.deleteSession();

    expect(requests).toEqual([
      "POST /session",
      "GET /session/mock-session/window",
      "DELETE /session/mock-session",
    ]);
  });
});
