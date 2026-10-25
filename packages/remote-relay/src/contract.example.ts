import type { RelayDeviceStore, RelayServerOptions, RelaySessionService } from "./contract.js";

export function relayExample(
  store: RelayDeviceStore,
  session: RelaySessionService,
): RelayServerOptions {
  return { store, session, host: "127.0.0.1", port: 0 };
}
