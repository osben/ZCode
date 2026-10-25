import { describe, expect, it } from "vitest";
import type { WebRemoteControlDeviceGroup } from "#src/web-remote-control/index.js";

import {
  KNOWN_DEVICES_KEY,
  KNOWN_DEVICES_LIMIT,
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/index.js";

function memoryStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(KNOWN_DEVICES_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const onlineGroup = (
  deviceMid: string,
  name?: string,
  platform?: string,
): WebRemoteControlDeviceGroup => ({
  deviceMid,
  name,
  platform,
  onlineConnections: [
    {
      device_sid: `${deviceMid}-sid`,
      device_mid: deviceMid,
      online: true,
      created_at: 1,
      meta: {},
    },
  ],
});

describe("locally remembered device names and platforms", () => {
  it("accepts legacy [mid, name] pairs and [mid, name, platform], ignores entries of the wrong shape, and trims leading and trailing whitespace", () => {
    const storage = memoryStorage(
      JSON.stringify([
        ["mid-1", " One "],
        ["mid-2"],
        "junk",
        ["mid-3", "   "],
        [3, "x"],
        ["", "empty"],
        ["mid-4", "Four", " darwin "],
        ["mid-5", "", "linux"],
        ["mid-6", "Six", 7],
        ["mid-7", "Seven", "win32", "extra"],
      ]),
    );
    expect([...readKnownDevices(storage)]).toEqual([
      ["mid-1", { name: "One" }],
      ["mid-4", { name: "Four", platform: "darwin" }],
      ["mid-5", { platform: "linux" }],
    ]);
  });

  it("a missing value, non-array JSON, corrupted content, or a read that throws are all treated as no remembered device", () => {
    expect(readKnownDevices(memoryStorage()).size).toBe(0);
    expect(readKnownDevices(memoryStorage('{"mid-1":"One"}')).size).toBe(0);
    expect(readKnownDevices(memoryStorage("{not json")).size).toBe(0);
    expect(
      readKnownDevices({
        getItem() {
          throw new Error("blocked");
        },
        setItem() {},
      }).size,
    ).toBe(0);
  });

  it("only writes device entries that have an online connection and a name or platform; a device seen again moves to the most recent position", () => {
    const storage = memoryStorage(
      JSON.stringify([
        ["mid-a", "A"],
        ["mid-b", "B", "win32"],
      ]),
    );
    const known = readKnownDevices(storage);
    rememberKnownDevices(storage, known, [
      onlineGroup("mid-a", "A renamed", "darwin"),
      onlineGroup("mid-c", "C"),
      onlineGroup("mid-d"),
      onlineGroup("mid-p", undefined, "linux"),
      { deviceMid: "mid-e", name: "E (offline, from cache)", onlineConnections: [] },
    ]);
    expect(JSON.parse(storage.map.get(KNOWN_DEVICES_KEY)!)).toEqual([
      ["mid-b", "B", "win32"],
      ["mid-a", "A renamed", "darwin"],
      ["mid-c", "C"],
      ["mid-p", "", "linux"],
    ]);
  });

  it("does not touch storage when there are no writable device entries", () => {
    const storage = memoryStorage(JSON.stringify([["mid-a", "A"]]));
    const known = readKnownDevices(storage);
    let writes = 0;
    rememberKnownDevices({ ...storage, setItem: () => void writes++ }, known, [
      { deviceMid: "mid-a", name: "A", onlineConnections: [] },
      onlineGroup("mid-x"),
    ]);
    expect(writes).toBe(0);
  });

  it(`evicts the least recently updated entries when there are more than ${KNOWN_DEVICES_LIMIT}`, () => {
    const seeded = Array.from({ length: KNOWN_DEVICES_LIMIT }, (_, i) => [`mid-${i}`, `D${i}`]);
    const storage = memoryStorage(JSON.stringify(seeded));
    const known = readKnownDevices(storage);
    rememberKnownDevices(storage, known, [
      onlineGroup("mid-0", "D0"),
      onlineGroup("mid-new", "New"),
    ]);
    const stored = JSON.parse(storage.map.get(KNOWN_DEVICES_KEY)!) as [string, string][];
    expect(stored).toHaveLength(KNOWN_DEVICES_LIMIT);
    expect(stored[0]).toEqual(["mid-2", "D2"]);
    expect(stored.at(-2)).toEqual(["mid-0", "D0"]);
    expect(stored.at(-1)).toEqual(["mid-new", "New"]);
  });

  it("silently ignores write failures; the in-memory mapping is still updated", () => {
    const known = new Map();
    expect(() =>
      rememberKnownDevices(
        {
          getItem: () => null,
          setItem() {
            throw new Error("blocked");
          },
        },
        known,
        [onlineGroup("mid-a", "A", "darwin")],
      ),
    ).not.toThrow();
    expect([...known]).toEqual([["mid-a", { name: "A", platform: "darwin" }]]);
  });
});
