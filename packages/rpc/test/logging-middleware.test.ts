import { describe, expect, it, vi } from "vitest";
import { Event } from "../src/foundation.js";
import { LoggingChannelClient, LoggingChannelServer } from "../src/logging-middleware.js";
import type { IChannel, IChannelClient, IChannelServer, IServerChannel } from "../src/channels.js";

describe("logging middleware", () => {
  it("logs media preview prepare success using the channel and command names", async () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("media-preview", {
      async call() {
        return { kind: "local-url" };
      },
      listen: vi.fn(),
    });

    await registeredChannel?.call("ctx", "prepare", {});

    expect(logs.some((log) => log.startsWith("[rpc:call] media-preview.prepare OK "))).toBe(true);
  });

  it("logs listen failures without reporting a successful subscription", () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("events", {
      call: vi.fn(),
      listen() {
        throw new Error("listen failed");
      },
    });

    expect(registeredChannel).toBeDefined();
    expect(() => registeredChannel?.listen("ctx", "onData")).toThrow("listen failed");
    expect(logs).toContain('[rpc:register] channel "events"');
    expect(logs).toContain("[rpc:listen] events.onData FAIL");
    expect(logs).not.toContain("[rpc:listen] events.onData subscribed");
  });

  it("logs successful listen subscriptions after the inner channel returns", () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("events", {
      call: vi.fn(),
      listen() {
        return Event.None;
      },
    });

    registeredChannel?.listen("ctx", "onData");

    expect(logs).toContain("[rpc:listen] events.onData subscribed");
    expect(logs).not.toContain("[rpc:listen] events.onData FAIL");
  });

  it("labels resolved ok:false business results as OK (ok:false) on the server channel", async () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("git", {
      async call() {
        return { ok: false, issues: [{ code: "unknown" }] };
      },
      listen: vi.fn(),
    });

    await registeredChannel?.call("ctx", "createWorktree", {});

    expect(logs.some((log) => log.startsWith("[rpc:call] git.createWorktree OK (ok:false) "))).toBe(
      true,
    );
    expect(logs.some((log) => log.includes("issues"))).toBe(false);
  });

  it("labels resolved ok:false business results as OK (ok:false) on the client channel", async () => {
    const innerChannel: IChannel = {
      async call() {
        return { ok: false };
      },
      listen: vi.fn(),
    } as unknown as IChannel;
    const innerClient: IChannelClient = {
      getChannel: () => innerChannel,
    } as unknown as IChannelClient;
    const logs: string[] = [];
    const client = new LoggingChannelClient(innerClient, (message) => {
      logs.push(message);
    });

    await client.getChannel("git").call("createWorktree", {});

    expect(
      logs.some((log) => log.startsWith("[rpc:call] git.createWorktree → OK (ok:false) ")),
    ).toBe(true);
  });

  it("keeps plain OK for successful payloads without an ok:false marker", async () => {
    let registeredChannel: IServerChannel<string> | undefined;
    const innerServer: IChannelServer<string> = {
      registerChannel(_channelName, channel) {
        registeredChannel = channel;
      },
    };
    const logs: string[] = [];
    const server = new LoggingChannelServer(innerServer, (message) => {
      logs.push(message);
    });

    server.registerChannel("git", {
      async call() {
        return { ok: true };
      },
      listen: vi.fn(),
    });

    await registeredChannel?.call("ctx", "createWorktree", {});

    expect(logs.some((log) => log.startsWith("[rpc:call] git.createWorktree OK "))).toBe(true);
    expect(logs.some((log) => log.includes("ok:false"))).toBe(false);
  });
});
