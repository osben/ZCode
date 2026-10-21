import { parseWebRemoteControlRelayV2IncomingMessage } from "#src/web-remote-relay/contractV2.js";
export const matchedDevice = parseWebRemoteControlRelayV2IncomingMessage({
  type: "auth_ack",
  device_sid: "device-example",
  pair_status: "matched",
});
