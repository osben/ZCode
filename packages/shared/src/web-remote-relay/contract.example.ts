import { relayClientMessageSchema } from "./contract.js";

export const relayAuthExample = relayClientMessageSchema.parse({
  type: "auth_init",
  role: "terminal",
  device_sid: "fixture-device",
  meta: { platform: "web", version: "fixture", name: "fixture" },
});
