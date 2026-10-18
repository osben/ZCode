import { afterEach, describe, expect, it, vi } from "vitest";
import { listeningAddress } from "./listeningAddress.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { SERVER_REMOTE_PROTOCOL_VERSION } from "@zcode/shared";
import { createHttpServer } from "../src/http.js";

describe("server info HTTP endpoint", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("returns desktop connector bootstrap metadata", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      serverId: "studio",
      name: "Studio Server",
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
    });
    servers.push(server);
    const address = await listeningAddress(server);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      serverId: "studio",
      name: "Studio Server",
      version: expect.any(String),
      protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
      authRequired: false,
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });
  });

  it("requires the lite token for protected API routes", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      authToken: "secret-token",
    });
    servers.push(server);
    const address = await listeningAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rejected = await fetch(`${baseUrl}/api/server-info`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/server-info?token=secret-token`);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("zcode_lite_token=");

    const cookieAccepted = await fetch(`${baseUrl}/api/server-info`, {
      headers: {
        cookie: "zcode_lite_token=secret-token",
      },
    });
    expect(cookieAccepted.status).toBe(200);

    const capabilityRejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(capabilityRejected.status).toBe(401);
    const capabilityAccepted = await fetch(
      `${baseUrl}/api/rpc-host-capability?token=secret-token`,
      { method: "POST" },
    );
    expect(capabilityAccepted.status).toBe(200);
    await expect(capabilityAccepted.json()).resolves.toMatchObject({
      capability: expect.any(String),
      expiresAt: expect.any(Number),
    });

    const connectRejected = await fetch(`${baseUrl}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(connectRejected.status).toBe(401);

    const info = await fetch(`${baseUrl}/api/server-info?token=secret-token`);
    await expect(info.json()).resolves.toMatchObject({ authRequired: true });
  });

  it.each([
    ["GET", "/%61pi/server-info"],
    ["GET", "/%2561pi/server-info"],
    ["GET", "/API/server-info"],
    ["GET", "//api/server-info"],
    ["GET", "/api%2Fserver-info"],
    ["GET", "/api%2fserver-info"],
    ["GET", "/api/server-info/"],
    ["GET", "/api"],
    ["POST", "/%61pi/rpc-host-capability"],
    ["POST", "/%41PI/rpc-host-capability"],
    ["POST", "/%61pi/connect-remote"],
    ["POST", "/anything-not-public"],
  ])("rejects %s %s without the token", async (method, path) => {
    const server = createHttpServer(new ServiceCollection(), 0, { authToken: "secret-token" });
    servers.push(server);
    const address = await listeningAddress(server);

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }
        : {}),
    });

    expect(response.status).toBe(401);
  });

  it.each(["/ws", "/%77s", "/%2577s", "/WS", "/%77s/host", "/ws%2Fhost", "/%77s/remote/x"])(
    "refuses the WebSocket upgrade on %s without the token",
    async (path) => {
      const server = createHttpServer(new ServiceCollection(), 0, { authToken: "secret-token" });
      servers.push(server);
      const address = await listeningAddress(server);

      const status = await new Promise<number | "open">((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`);
        socket.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.once("open", () => {
          resolve("open");
          socket.close();
        });
        socket.once("error", (error) => reject(error));
      });

      expect(status).toBe(401);
    },
  );

  it("still serves public static assets without the token", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>lite</html>", "utf8");
    const server = createHttpServer(new ServiceCollection(), 0, {
      authToken: "secret-token",
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    const address = await listeningAddress(server);

    const page = await fetch(`http://127.0.0.1:${address.port}/workspace/deep/link`);

    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toBe("<html>lite</html>");
  });

  it("binds loopback by default when no token is configured", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);

    const address = await listeningAddress(server);

    expect(address.address).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
    await expect(response.json()).resolves.toMatchObject({ authRequired: false });
  });

  it("does not derive authRequired from environment variables", async () => {
    vi.stubEnv("ZCODE_SERVER_TOKEN", "unused");
    vi.stubEnv("ZCODE_SERVER_AUTH_TOKEN", "unused");
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = await listeningAddress(server);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);

    await expect(response.json()).resolves.toMatchObject({ authRequired: false });
  });

  it.each(["0.0.0.0", "::", "192.168.1.10"])(
    "refuses to listen on non-loopback host %s without a token",
    (host) => {
      expect(() => createHttpServer(new ServiceCollection(), 0, { host })).toThrow(
        /Refusing to listen on non-loopback host/,
      );
    },
  );

  it("listens on a non-loopback host when a token is configured", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      host: "0.0.0.0",
      authToken: "secret-token",
    });
    servers.push(server);
    const address = await listeningAddress(server);

    expect(address.address).toBe("0.0.0.0");
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(rejected.status).toBe(401);
  });

  it("serves static web files with SPA fallback", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>lite</html>", "utf8");
    await writeFile(join(staticRoot, "app.js"), "console.log('lite');", "utf8");

    const server = createHttpServer(new ServiceCollection(), 0, {
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    const address = await listeningAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const asset = await fetch(`${baseUrl}/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    await expect(asset.text()).resolves.toBe("console.log('lite');");

    const fallback = await fetch(`${baseUrl}/workspace/deep/link`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    await expect(fallback.text()).resolves.toBe("<html>lite</html>");

    const apiFallback = await fetch(`${baseUrl}/api/missing`);
    expect(apiFallback.status).toBe(404);
  });
});
