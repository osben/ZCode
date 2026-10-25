import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  ChannelServer,
  ChannelClient,
  IServerChannel,
  getDelayedChannel,
} from "../src/channels.js";
import { createQueuePair, SocketProtocol, type ISocket } from "../src/protocol.js";
import { CancellationTokenSource, Emitter, Event, DisposableStore } from "../src/foundation.js";
import { VSBuffer } from "../src/buffer.js";

function createPair(ctx = "test-ctx") {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, ctx);
  const client = new ChannelClient(clientProtocol);
  return {
    server,
    client,
    dispose: () => {
      server.dispose();
      client.dispose();
    },
  };
}

function createFragmentedSocketPair(fragmentSize = 7): [ISocket, ISocket] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();
  const closeA = new Emitter<void>();
  const closeB = new Emitter<void>();
  const endA = new Emitter<void>();
  const endB = new Emitter<void>();

  function splitBuffer(buffer: VSBuffer): VSBuffer[] {
    const chunks: VSBuffer[] = [];
    for (let offset = 0; offset < buffer.byteLength; offset += fragmentSize) {
      chunks.push(buffer.slice(offset, Math.min(offset + fragmentSize, buffer.byteLength)));
    }
    return chunks;
  }

  const socketA: ISocket = {
    onData: emitterA.event,
    onClose: closeA.event,
    onEnd: endA.event,
    write(buffer) {
      for (const chunk of splitBuffer(buffer)) {
        setTimeout(() => emitterB.fire(chunk), 0);
      }
    },
    end() {
      closeA.fire();
      endA.fire();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      closeA.fire();
      endA.fire();
    },
  };

  const socketB: ISocket = {
    onData: emitterB.event,
    onClose: closeB.event,
    onEnd: endB.event,
    write(buffer) {
      for (const chunk of splitBuffer(buffer)) {
        setTimeout(() => emitterA.fire(chunk), 0);
      }
    },
    end() {
      closeB.fire();
      endB.fire();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      closeB.fire();
      endB.fire();
    },
  };

  return [socketA, socketB];
}

describe("ChannelServer + ChannelClient", () => {
  it("should call a method on a registered channel", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call(_ctx, command, arg) {
        if (command === "add") return Promise.resolve(arg[0] + arg[1]);
        return Promise.reject(new Error("Unknown command"));
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("math", channel);
    const ch = client.getChannel("math");
    const result = await ch.call("add", [3, 4]);
    expect(result).toBe(7);
    dispose();
  });

  it("should propagate errors", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call() {
        return Promise.reject(new Error("boom"));
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("fail", channel);
    const ch = client.getChannel("fail");
    await expect(ch.call("anything")).rejects.toThrow("boom");
    dispose();
  });

  it("should reject in-flight calls when the client is disposed", async () => {
    const { server, client } = createPair();
    const call = vi.fn(() => new Promise(() => {}));
    server.registerChannel("hang", {
      call,
      listen() {
        return Event.None;
      },
    });

    const resultPromise = client.getChannel("hang").call("wait");
    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledTimes(1);
    });

    const reason = Object.assign(new Error("remote connection closed"), {
      code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
    });
    client.dispose(reason);

    await expect(resultPromise).rejects.toBe(reason);
    server.dispose();
  });

  it("should reject requests queued before Initialize when the client is disposed", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test-ctx", 1000, true);
    const client = new ChannelClient(clientProtocol);
    const resultPromise = client.getChannel("lazy").call("wait");
    const reason = new Error("initialization connection closed");

    client.dispose(reason);

    await expect(resultPromise).rejects.toBe(reason);
    server.dispose();
  });

  it("should keep event subscriptions outside pending promise rejection", async () => {
    const { server, client } = createPair();
    const source = new Emitter<string>();
    const listen = vi.fn(() => source.event);
    server.registerChannel("events-dispose", {
      call() {
        return Promise.resolve();
      },
      listen,
    });

    const listener = vi.fn();
    const subscription = client.getChannel("events-dispose").listen("onData")(listener);
    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(1);
    });

    client.dispose();
    source.fire("after-dispose");

    expect(listener).not.toHaveBeenCalled();
    subscription.dispose();
    server.dispose();
  });

  it("should preserve structured error fields on Error instances", async () => {
    const { server, client, dispose } = createPair();

    const channel: IServerChannel = {
      call() {
        const error = new Error("Internal error") as Error & {
          code?: number;
          data?: { details: string };
          details?: { requestId: string; issues: Array<{ code: string; scope: string }> };
          kind?: string;
          status?: number;
          retryable?: boolean;
        };
        error.name = "RequestError";
        error.code = -32603;
        error.kind = "artifact_not_allowed";
        error.status = 422;
        error.data = {
          details: "Cannot set permission mode to auto: auto mode unavailable for this model",
        };
        error.details = {
          requestId: "server-request-123",
          issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
        };
        error.retryable = false;
        return Promise.reject(error);
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("fail-structured", channel);
    const ch = client.getChannel("fail-structured");

    try {
      await ch.call("anything");
      throw new Error("expected failure");
    } catch (error) {
      const typedError = error as Error & {
        code?: number;
        data?: { details?: string };
        details?: { requestId?: string; issues?: Array<{ code: string; scope: string }> };
        kind?: string;
        status?: number;
        retryable?: boolean;
      };
      expect(typedError.message).toBe("Internal error");
      expect(typedError.name).toBe("RequestError");
      expect(typedError.code).toBe(-32603);
      expect(typedError.kind).toBe("artifact_not_allowed");
      expect(typedError.status).toBe(422);
      expect(typedError.data?.details).toBe(
        "Cannot set permission mode to auto: auto mode unavailable for this model",
      );
      expect(typedError.details).toEqual({
        requestId: "server-request-123",
        issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
      });
      expect(typedError.retryable).toBe(false);
    } finally {
      dispose();
    }
  });

  it("should listen to events", async () => {
    const { server, client, dispose } = createPair();

    const emitter = new Emitter<string>();
    const channel: IServerChannel = {
      call() {
        return Promise.resolve();
      },
      listen(_ctx, event) {
        if (event === "onData") return emitter.event;
        return Event.None;
      },
    };

    server.registerChannel("events", channel);
    const ch = client.getChannel("events");

    const values: string[] = [];
    const received = new Promise<void>((resolve) => {
      ch.listen<string>("onData")((v) => {
        values.push(v);
        if (values.length === 2) resolve();
      });
    });

    // Wait for the client to be initialized and event subscription to be registered
    await new Promise((r) => setTimeout(r, 50));
    emitter.fire("first");
    emitter.fire("second");

    await received;
    expect(values).toEqual(["first", "second"]);
    dispose();
  });

  it("should queue requests for channels registered later", async () => {
    const { server, client, dispose } = createPair();

    const ch = client.getChannel("lazy");
    const resultPromise = ch.call<number>("getValue");

    // Register the channel after the call
    await new Promise((r) => setTimeout(r, 50));
    const channel: IServerChannel = {
      call(_ctx, command) {
        if (command === "getValue") return Promise.resolve(42);
        return Promise.reject(new Error("Unknown"));
      },
      listen() {
        return Event.None;
      },
    };
    server.registerChannel("lazy", channel);

    const result = await resultPromise;
    expect(result).toBe(42);
    dispose();
  });

  it("should pass ctx to server channel", async () => {
    const { server, client, dispose } = createPair("my-client");

    let receivedCtx: string | undefined;
    const channel: IServerChannel<string> = {
      call(ctx) {
        receivedCtx = ctx;
        return Promise.resolve("ok");
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("ctx-test", channel);
    const ch = client.getChannel("ctx-test");
    await ch.call("test");
    expect(receivedCtx).toBe("my-client");
    dispose();
  });

  it("should handle multiple concurrent RPC calls over fragmented socket frames", async () => {
    const [serverSocket, clientSocket] = createFragmentedSocketPair(5);
    const serverProtocol = new SocketProtocol(serverSocket);
    const clientProtocol = new SocketProtocol(clientSocket);
    const server = new ChannelServer(serverProtocol, "fragmented");
    const client = new ChannelClient(clientProtocol);
    const disposables = new DisposableStore();

    const channel: IServerChannel = {
      call(_ctx, command, arg) {
        switch (command) {
          case "listTasks":
            return Promise.resolve([{ workspacePath: arg.workspacePath }]);
          case "getWorkspaceProviderConfigFile":
            return Promise.resolve({
              provider: arg.provider,
              path: `${arg.workspacePath}/config.json`,
              exists: true,
            });
          case "prepareWorkspace":
            return Promise.resolve({
              workspacePath: arg.workspacePath,
              provider: arg.provider,
              preparedSessionId: "prepared-session",
              version: "0.0.0-test",
              configOptions: [],
              slashCommands: [],
            });
          default:
            return Promise.reject(new Error(`Unknown command: ${command}`));
        }
      },
      listen() {
        return Event.None;
      },
    };

    server.registerChannel("acp", channel);
    const acp = client.getChannel("acp");

    const [listResult, configResult, prepareResult] = await Promise.all([
      acp.call("listTasks", { workspacePath: "/root" }),
      acp.call("getWorkspaceProviderConfigFile", {
        workspacePath: "/root",
        provider: "claude",
      }),
      acp.call("prepareWorkspace", {
        workspacePath: "/root",
        provider: "claude",
      }),
    ]);

    expect(listResult).toEqual([{ workspacePath: "/root" }]);
    expect(configResult).toEqual({
      provider: "claude",
      path: "/root/config.json",
      exists: true,
    });
    expect(prepareResult).toEqual({
      workspacePath: "/root",
      provider: "claude",
      preparedSessionId: "prepared-session",
      version: "0.0.0-test",
      configOptions: [],
      slashCommands: [],
    });

    disposables.dispose();
    server.dispose();
    client.dispose();
    serverProtocol.dispose();
    clientProtocol.dispose();
  });
});

describe("ChannelServer pending requests for unregistered channels", () => {
  const timeoutMs = 1000;
  // Initialize and the request each take one macrotask hop over the queue pair.
  const deliveryMs = 10;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createShortTimeoutPair() {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test-ctx", timeoutMs);
    const client = new ChannelClient(clientProtocol);
    return {
      server,
      client,
      dispose: () => {
        server.dispose();
        client.dispose();
      },
    };
  }

  function advance(ms: number) {
    return vi.advanceTimersByTimeAsync(ms);
  }

  function createRecordingChannel() {
    const source = new Emitter<string>();
    const call = vi.fn(() => Promise.resolve("late"));
    const listen = vi.fn(() => source.event);
    const channel: IServerChannel = { call, listen };
    return { channel, call, listen, source };
  }

  it("does not execute a timed-out call when the channel registers later", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, client, dispose } = createShortTimeoutPair();
    try {
      const result = client.getChannel("missing").call("doThing", { a: 1 });
      const assertion = expect(result).rejects.toThrow(/timed out/);
      await advance(timeoutMs + deliveryMs);
      await assertion;

      const { channel, call } = createRecordingChannel();
      server.registerChannel("missing", channel);
      await advance(deliveryMs);

      expect(call).not.toHaveBeenCalled();
    } finally {
      dispose();
      errorSpy.mockRestore();
    }
  });

  it("does not execute a pending call cancelled before the channel registers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, client, dispose } = createShortTimeoutPair();
    try {
      const cts = new CancellationTokenSource();
      const result = client.getChannel("late").call("doThing", undefined, cts.token);
      await advance(deliveryMs);
      cts.cancel();
      await expect(result).rejects.toThrow("Cancelled");
      await advance(deliveryMs);

      const { channel, call } = createRecordingChannel();
      server.registerChannel("late", channel);
      await advance(timeoutMs * 2);

      expect(call).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      dispose();
      errorSpy.mockRestore();
    }
  });

  it("keeps a pending listen past the timeout and subscribes on late registration", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, client, dispose } = createShortTimeoutPair();
    try {
      const listener = vi.fn();
      const subscription = client.getChannel("late-events").listen<string>("onData")(listener);
      await advance(timeoutMs * 2);
      expect(errorSpy).toHaveBeenCalledWith("Unknown channel: late-events");

      const { channel, listen, source } = createRecordingChannel();
      server.registerChannel("late-events", channel);
      await advance(deliveryMs);
      expect(listen).toHaveBeenCalledTimes(1);

      source.fire("hello");
      await advance(deliveryMs);
      expect(listener).toHaveBeenCalledWith("hello");
      subscription.dispose();
    } finally {
      dispose();
      errorSpy.mockRestore();
    }
  });

  it("does not subscribe a pending listen disposed before the channel registers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, client, dispose } = createShortTimeoutPair();
    try {
      const subscription = client.getChannel("late-events").listen<string>("onData")(vi.fn());
      await advance(timeoutMs * 2);
      expect(errorSpy).toHaveBeenCalledWith("Unknown channel: late-events");
      subscription.dispose();
      await advance(deliveryMs);

      const { channel, listen } = createRecordingChannel();
      server.registerChannel("late-events", channel);
      await advance(deliveryMs);

      expect(listen).not.toHaveBeenCalled();
    } finally {
      dispose();
      errorSpy.mockRestore();
    }
  });

  it("clears pending timers on dispose", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, client } = createShortTimeoutPair();
    try {
      void client
        .getChannel("missing")
        .call("doThing")
        .catch(() => {});
      await advance(deliveryMs);
      expect(vi.getTimerCount()).toBe(1);
      server.dispose();

      expect(vi.getTimerCount()).toBe(0);
      await advance(timeoutMs * 2);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      client.dispose();
      errorSpy.mockRestore();
    }
  });
});

describe("getDelayedChannel", () => {
  it("should delay call until promise resolves", async () => {
    const emitter = new Emitter<void>();
    let resolved = false;

    const channelPromise = new Promise<any>((resolve) => {
      emitter.event(() => {
        resolved = true;
        resolve({
          call: () => Promise.resolve("delayed-result"),
          listen: () => Event.None,
        });
      });
    });

    const delayed = getDelayedChannel(channelPromise);
    const resultPromise = delayed.call("test");

    expect(resolved).toBe(false);
    emitter.fire();

    const result = await resultPromise;
    expect(result).toBe("delayed-result");
  });
});
