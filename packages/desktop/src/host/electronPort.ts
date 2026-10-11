import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

/**
 * Adapt Electron's MessagePortMain to the RPC layer's MessagePortLike interface.
 *
 * Electron's MessagePortMain uses the Node EventEmitter style (.on/.off),
 * while MessagePortLike uses the Web standard style (addEventListener/removeEventListener).
 * This adapter bridges the difference so MessagePortProtocol can be used directly in utilityProcess.
 */
export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain's message event already has the { data } shape, so forward it directly.
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
