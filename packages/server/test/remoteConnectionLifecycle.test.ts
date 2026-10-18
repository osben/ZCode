import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { listeningAddress } from "./listeningAddress.js";
import { createHttpServer } from "../src/http.js";
import { connectRemote } from "../src/remote/index.js";

vi.mock("../src/remote/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote/index.js")>();
  return {
    ...actual,
    createRemoteBackend: vi.fn(() => ({ dispose: vi.fn() })),
    connectRemote: vi.fn(async () => ({
      services: {
        fileService: {},
        gitService: {},
        systemService: {},
        terminalService: {},
      },
      client: {},
      dispose: vi.fn(),
      disposeAndWait: vi.fn(async () => undefined),
    })),
  };
});

const SSH_TARGET = { kind: "ssh", host: "example.test", username: "user" };

describe("remote connection lifecycle over HTTP", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function openConnection(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SSH_TARGET),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    return body.id;
  }

  function openRemoteSocket(baseUrl: string, id: string): Promise<WebSocket> {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/remote/${id}`);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  function closeCodeOf(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  }

  it("disposes the claimed remote connection when its WebSocket closes", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = await listeningAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const id = await openConnection(baseUrl);
    const connection = await vi.mocked(connectRemote).mock.results[0].value;
    const socket = await openRemoteSocket(baseUrl, id);
    expect(connection.dispose).not.toHaveBeenCalled();

    const closed = closeCodeOf(socket);
    socket.close();
    await closed;

    await vi.waitFor(() => expect(connection.dispose).toHaveBeenCalledTimes(1));
  });

  it("rejects a second claim of the same connection id with 4004", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = await listeningAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const id = await openConnection(baseUrl);
    const first = await openRemoteSocket(baseUrl, id);
    const firstClosed = closeCodeOf(first);
    const second = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/remote/${id}`);
    const secondClosed = closeCodeOf(second);

    await expect(secondClosed).resolves.toBe(4004);
    first.close();
    await firstClosed;
  });
});
