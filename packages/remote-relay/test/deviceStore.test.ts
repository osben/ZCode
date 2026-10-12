import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createRelayDeviceStore } from "../src/adapters/deviceStore.js";

it("keeps SID lookups read-only and timestamps only explicit authenticated admissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-relay-auth-time-"));
  const path = join(directory, "relay.sqlite");
  const store = await createRelayDeviceStore({
    path,
    storageKey: randomBytes(32).toString("base64"),
  });
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const record = await store.register("fixture-machine", "fixture-key");
    const timestamp = () =>
      database.prepare("SELECT authenticated_at FROM registrations WHERE sid = ?").get(record.sid)!
        .authenticated_at;
    expect(timestamp()).toBeNull();
    expect(await store.get(record.sid)).toEqual(record);
    expect(await store.get(record.sid)).toEqual(record);
    expect(timestamp()).toBeNull();
    await store.touch(record.sid);
    expect(timestamp()).toEqual(expect.any(Number));
    const authenticatedAt = timestamp();
    expect(await store.get(record.sid)).toEqual(record);
    expect(timestamp()).toBe(authenticatedAt);
    await expect(store.touch("missing-sid")).rejects.toThrow(
      "Registration store operation failed.",
    );
  } finally {
    database.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("persists an encrypted registration and reuses it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-relay-store-"));
  const path = join(directory, "relay.sqlite");
  const storageKey = randomBytes(32).toString("base64");
  const store = await createRelayDeviceStore({ path, storageKey, maxRecords: 2 });
  let first: { sid: string; key: string };
  try {
    first = await store.register("machine-1", "dummy-registration-secret-for-test");
    expect(await store.register("machine-1", "dummy-registration-secret-for-test")).toEqual(first);
    const other = await store.register("machine-1", "different-dummy-secret");
    expect(other.sid).not.toBe(first.sid);
    await expect(store.register("machine-2", "third-dummy-secret")).rejects.toThrow();
  } finally {
    await store.close();
  }
  expect((await readFile(path)).includes(Buffer.from("dummy-registration-secret-for-test"))).toBe(
    false,
  );
  const reopened = await createRelayDeviceStore({ path, storageKey, maxRecords: 2 });
  try {
    expect(await reopened.get(first!.sid)).toEqual(first!);
  } finally {
    await reopened.close();
  }
  await expect(
    createRelayDeviceStore({ path, storageKey: randomBytes(32).toString("base64"), maxRecords: 2 }),
  ).rejects.toThrow();
});
