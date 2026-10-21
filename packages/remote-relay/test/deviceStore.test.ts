import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayDeviceStore } from "../src/adapters/deviceStore.js";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-device-store-"));
  path = join(directory, "relay.sqlite");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("device record store", () => {
  it("registers a new SID on every call for the same MID", async () => {
    const store = await createRelayDeviceStore({ path });
    const first = await store.register("user-1", "mid-a", 100);
    const second = await store.register("user-1", "mid-a", 200);
    expect(first.deviceSid).not.toBe(second.deviceSid);
    expect(first).toEqual({
      deviceSid: first.deviceSid,
      userId: "user-1",
      deviceMid: "mid-a",
      createdAt: 100,
    });
    await store.close();
  });

  it("lists only the records of the requested user, oldest first", async () => {
    const store = await createRelayDeviceStore({ path });
    const late = await store.register("user-1", "mid-b", 300);
    const early = await store.register("user-1", "mid-a", 100);
    await store.register("user-2", "mid-c", 50);
    expect((await store.listForUser("user-1")).map((record) => record.deviceSid)).toEqual([
      early.deviceSid,
      late.deviceSid,
    ]);
    expect(await store.listForUser("nobody")).toEqual([]);
    await store.close();
  });

  it("returns undefined for an unknown SID and removes a record so it no longer resolves", async () => {
    const store = await createRelayDeviceStore({ path });
    const record = await store.register("user-1", "mid-a", 1);
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.remove(record.deviceSid)).toBe(true);
    expect(await store.get(record.deviceSid)).toBeUndefined();
    expect(await store.remove(record.deviceSid)).toBe(false);
    await store.close();
  });

  it("keeps records across a restart", async () => {
    const first = await createRelayDeviceStore({ path });
    const record = await first.register("user-1", "mid-a", 42);
    await first.close();
    const reopened = await createRelayDeviceStore({ path });
    expect(await reopened.get(record.deviceSid)).toEqual(record);
    await reopened.close();
  });

  it("rejects registrations beyond the configured record limit", async () => {
    const store = await createRelayDeviceStore({ path, maxRecords: 1 });
    await store.register("user-1", "mid-a", 1);
    await expect(store.register("user-1", "mid-b", 2)).rejects.toThrow(
      "Device store operation failed.",
    );
    await store.close();
  });

  it("refuses to open with a non-positive record limit", async () => {
    await expect(createRelayDeviceStore({ path, maxRecords: 0 })).rejects.toThrow("positive");
  });
});
