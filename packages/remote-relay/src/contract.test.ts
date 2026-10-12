import { expect, it } from "vitest";
import { relayExample } from "./contract.example.js";

it("composes an explicitly supplied store without workspace services", () => {
  const store = {
    register: async () => ({ sid: "fixture", key: "fixture" }),
    get: async () => undefined,
    touch: async () => {},
    close: async () => {},
  };
  expect(relayExample(store)).toEqual({ store, host: "127.0.0.1", port: 0 });
});
