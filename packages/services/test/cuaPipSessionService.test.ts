import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import type { PipSessionClient } from "@zcode/zcode-cua/pip-session/node";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import {
  createCuaPipSessionService,
  type CuaPipPresentationCredentials,
} from "../src/cua-permission-broker/cuaPipSessionService.js";

function createFakeClient(): PipSessionClient {
  return {
    enabled: true,
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ applied: true })),
    close: vi.fn(),
  };
}

function createFakeLogger(): ServiceLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;
type LifecycleEvent = Exclude<PipSessionEvent, FocusEvent>;

function focusChanged(revision: number): FocusEvent {
  return { kind: "focus-changed", sessionId: null, revision, sourceWindowId: "window-1" };
}

function turnStarted(turnId: string): LifecycleEvent {
  return { kind: "turn-started", sessionId: "session-1", turnId, sequenceNumber: 1 };
}

function createTestService(options: {
  logger: ServiceLogger;
  client: PipSessionClient;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
}) {
  return createCuaPipSessionService({
    enabled: true,
    resolveCredentials: options.resolveCredentials,
    createClient: () => options.client,
    logger: options.logger,
  });
}

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("createCuaPipSessionService delivery-skip logging", () => {
  it("logs the first delivery skip at warn and demotes repeats to debug with a running total", async () => {
    const logger = createFakeLogger();
    const service = createTestService({
      logger,
      client: createFakeClient(),
      resolveCredentials: async () => undefined,
    });
    disposers.push(() => service.dispose());

    await service.publishFocus(focusChanged(1));
    await service.publishFocus(focusChanged(2));
    await service.publishFocus(focusChanged(3));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      undefined,
      "[cua-pip-session] event delivery skipped",
      expect.objectContaining({ kind: "focus-changed", skipReason: "credentials-unavailable" }),
    );
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenLastCalledWith(
      undefined,
      "[cua-pip-session] event delivery skipped",
      expect.objectContaining({ skipReason: "credentials-unavailable", droppedTotal: 3 }),
    );
  });

  it("emits a single recovery warn with the aggregated skipped count and resets the streak", async () => {
    const logger = createFakeLogger();
    let credentials: CuaPipPresentationCredentials | undefined;
    const service = createTestService({
      logger,
      client: createFakeClient(),
      resolveCredentials: async () => credentials,
    });
    disposers.push(() => service.dispose());

    credentials = undefined;
    await service.publishFocus(focusChanged(1));
    await service.publishFocus(focusChanged(2));

    credentials = { socketPath: "/tmp/helper.sock" };
    await service.publishFocus(focusChanged(3));
    await service.publishFocus(focusChanged(4));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      undefined,
      "[cua-pip-session] event delivery recovered",
      { skipReason: "credentials-unavailable", skippedEvents: 2 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      undefined,
      "[cua-pip-session] event delivery acknowledged",
      expect.objectContaining({ kind: "focus-changed", applied: true }),
    );
  });

  it("starts a new warn streak when credentials become unavailable again", async () => {
    const logger = createFakeLogger();
    let credentials: CuaPipPresentationCredentials | undefined = { socketPath: "/tmp/helper.sock" };
    const service = createTestService({
      logger,
      client: createFakeClient(),
      resolveCredentials: async () => credentials,
    });
    disposers.push(() => service.dispose());

    await service.publishFocus(focusChanged(1));
    credentials = undefined;
    await service.publishFocus(focusChanged(2));
    await service.publishFocus(focusChanged(3));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    credentials = { socketPath: "/tmp/helper.sock" };
    await service.publishFocus(focusChanged(4));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      undefined,
      "[cua-pip-session] event delivery recovered",
      { skipReason: "credentials-unavailable", skippedEvents: 2 },
    );
  });

  it("ends the skip streak after a successful timer-driven replay without another publish", async () => {
    const logger = createFakeLogger();
    const client = createFakeClient();
    let credentials: CuaPipPresentationCredentials | undefined;
    const service = createTestService({
      logger,
      client,
      resolveCredentials: async () => credentials,
    });
    disposers.push(() => service.dispose());

    credentials = undefined;
    await service.publishLifecycle(turnStarted("turn-1"));

    credentials = { socketPath: "/tmp/helper.sock" };
    // No further publish: the replay retry timer must deliver the staged event and recover the streak on its own.
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        undefined,
        "[cua-pip-session] event delivery recovered",
        { skipReason: "credentials-unavailable", skippedEvents: 1 },
      );
    });
    expect(client.send).toHaveBeenCalledWith(turnStarted("turn-1"));

    // The streak ended with the replay, so the next skip warns again instead of continuing at debug.
    credentials = undefined;
    await service.publishFocus(focusChanged(1));
    expect(logger.warn).toHaveBeenCalledWith(
      undefined,
      "[cua-pip-session] event delivery skipped",
      expect.objectContaining({ kind: "focus-changed", skipReason: "credentials-unavailable" }),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("still stages and replays a deferred turn-started when credentials return", async () => {
    const logger = createFakeLogger();
    const client = createFakeClient();
    let credentials: CuaPipPresentationCredentials | undefined;
    const service = createTestService({
      logger,
      client,
      resolveCredentials: async () => credentials,
    });
    disposers.push(() => service.dispose());

    credentials = undefined;
    await service.publishLifecycle(turnStarted("turn-1"));
    expect(client.send).not.toHaveBeenCalled();

    credentials = { socketPath: "/tmp/helper.sock" };
    await service.publishFocus(focusChanged(1));

    expect(client.send).toHaveBeenNthCalledWith(1, turnStarted("turn-1"));
    expect(client.send).toHaveBeenNthCalledWith(2, focusChanged(1));
    expect(logger.info).toHaveBeenCalledWith(
      undefined,
      "[cua-pip-session] replayed deferred turn-started",
      expect.objectContaining({ turnId: "turn-1", applied: true }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      undefined,
      "[cua-pip-session] event delivery recovered",
      { skipReason: "credentials-unavailable", skippedEvents: 1 },
    );
  });
});
