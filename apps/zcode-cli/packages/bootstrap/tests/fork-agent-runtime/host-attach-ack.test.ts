// Fork: the Host's attach acknowledgement (specs/fork-rust-credential-cipher.md F1, scenario B6). Node does not gate
// its reverse requests on it, so the transport drops it on arrival and never queues it behind ordinary requests.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../../src/zcode-protocol/transport.js";

const frame = (message: ZCodeProtocolMessage) => `${JSON.stringify(message)}\n`;

describe("process/hostAttached on the Node agent", () => {
  it("is dropped without reaching the handler or blocking later requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        if ("method" in message) seen.push(message.method);
        return "id" in message && "method" in message
          ? { id: message.id, result: {} }
          : undefined;
      },
    });
    connection.start();
    input.write(
      frame({
        method: zcodeProtocolMethods.processHostAttached,
        params: { credentialCipher: true },
      }),
    );
    input.write(frame({ id: "after", method: "workspace/readState" }));
    await vi.waitFor(() => expect(seen).toEqual(["workspace/readState"]));
    input.end();
    await connection.waitForClose();
  });
});
