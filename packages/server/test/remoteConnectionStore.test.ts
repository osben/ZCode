import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteConnection } from "../src/remote/index.js";
import {
  createRemoteConnectionStore,
  REMOTE_CONNECTION_CLAIM_TTL_MS,
} from "../src/remoteConnectionStore.js";

function createFakeConnection(): RemoteConnection {
  return { dispose: vi.fn() } as unknown as RemoteConnection;
}

describe("remote connection store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a connection to exactly one claimer, never disposes it, and ignores unknown ids", () => {
    const store = createRemoteConnectionStore();
    const connection = createFakeConnection();
    const id = store.add(connection);

    expect(store.claim("missing")).toBeUndefined();
    expect(store.claim(id)).toBe(connection);
    expect(store.claim(id)).toBeUndefined();
    vi.advanceTimersByTime(REMOTE_CONNECTION_CLAIM_TTL_MS * 2);
    expect(connection.dispose).not.toHaveBeenCalled();
  });

  it("disposes an unclaimed connection once its TTL elapses", () => {
    const store = createRemoteConnectionStore({ ttlMs: 1_000 });
    const connection = createFakeConnection();
    const id = store.add(connection);

    vi.advanceTimersByTime(999);
    expect(connection.dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(store.claim(id)).toBeUndefined();
  });

  it("uses a 5 minute claim TTL by default", () => {
    expect(REMOTE_CONNECTION_CLAIM_TTL_MS).toBe(5 * 60_000);

    const store = createRemoteConnectionStore();
    const connection = createFakeConnection();
    store.add(connection);

    vi.advanceTimersByTime(REMOTE_CONNECTION_CLAIM_TTL_MS - 1);
    expect(connection.dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });
});
