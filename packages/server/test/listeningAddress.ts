import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { createHttpServer } from "../src/http.js";

/** A host-bound listen resolves the address asynchronously, so wait before reading the port. */
export async function listeningAddress(
  server: ReturnType<typeof createHttpServer>,
): Promise<AddressInfo> {
  if (!server.listening) {
    await once(server, "listening");
  }
  return server.address() as AddressInfo;
}
