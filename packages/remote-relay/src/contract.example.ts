import type { RelayServerOptions } from "./contract.js";

export function relayExample(store: RelayServerOptions["store"]): RelayServerOptions {
  return { store, host: "127.0.0.1", port: 0 };
}
