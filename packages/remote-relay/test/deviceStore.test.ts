import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createRelayDeviceStore } from "../src/adapters/deviceStore.js";

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
  } finally { await store.close(); }
  expect((await readFile(path)).includes(Buffer.from("dummy-registration-secret-for-test"))).toBe(false);
  const reopened = await createRelayDeviceStore({ path, storageKey, maxRecords: 2 });
  try { expect(await reopened.get(first!.sid)).toEqual(first!); }
  finally { await reopened.close(); }
  await expect(createRelayDeviceStore({ path, storageKey: randomBytes(32).toString("base64"), maxRecords: 2 }))
    .rejects.toThrow();
});
