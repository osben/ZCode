import { describe, expect, it } from "vitest";
import { relayClientMessageSchema } from "./contract.js";

describe("remote relay wire contract", () => {
  it("accepts the existing device registration envelope", () => {
    const message = {
      type: "device_register_init",
      device_mid: "machine-1",
      pass_hash: "dGVzdF9oYXNo",
      meta: { platform: "darwin", version: "3.15.1", name: "fixture" },
      client_ts: 1,
    };
    expect(relayClientMessageSchema.parse(message)).toEqual(message);
  });
});
