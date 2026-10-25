import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlMobileTaskView,
  WebRemoteControlMobileTaskViewUpdatePayload,
} from "@zcode/shared";
import type { WebRemoteControlTerminalTransportState } from "#src/web-remote-control/contract.js";

/** Only keeps the Reporter's current projection for transport recovery to reassert; task read state is still committed by the desktop, the sole writer. */
export function createWebRemoteControlTaskViewPublisher(
  send: (payload: WebRemoteControlMobileTaskViewUpdatePayload) => boolean,
) {
  let bridge: WebRemoteControlExternalWorkspaceBridge | undefined;
  let view: WebRemoteControlMobileTaskView | null = null;
  let epoch: string | undefined;
  let seq = 0;
  let dirty = false;
  const matches = (target: WebRemoteControlExternalWorkspaceBridge) =>
    bridge?.bridgeSessionId === target.bridgeSessionId &&
    bridge?.bridgeGeneration === target.bridgeGeneration;
  const flush = () => {
    if (!bridge || !epoch || !dirty) return;
    dirty = !send({
      zcode_type: "mobile-task-view-update",
      epoch,
      seq: ++seq,
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration !== undefined
        ? { bridgeGeneration: bridge.bridgeGeneration }
        : {}),
      view,
    });
  };
  const request = (nextEpoch: string) => {
    if (epoch !== nextEpoch) seq = 0;
    epoch = nextEpoch;
    dirty = true;
    flush();
  };
  const disconnected = () => {
    epoch = undefined;
    dirty = true;
  };
  return {
    request,
    seed(nextEpoch: string | undefined) {
      // A pairing request may arrive before the bootstrap response; a late bootstrap must not roll the newer epoch back.
      if (!epoch && nextEpoch) request(nextEpoch);
    },
    disconnected,
    suspend() {
      // The lifecycle listener is registered before the React Reporter; it must be revoked before the transport stops sending, and must not wait for a listener installed later.
      view = null;
      dirty = true;
      flush();
    },
    transportStateChanged(
      next: WebRemoteControlTerminalTransportState,
      previous: WebRemoteControlTerminalTransportState,
    ) {
      if (next === "paired") {
        flush();
      } else if (next !== "suspended" && !(next === "reconnecting" && previous === "suspended")) {
        // Suspension and probing the original socket do not change Main's epoch and must not reset seq; a real authentication/connect still requires a new declaration.
        disconnected();
      }
    },
    setBridge(next: WebRemoteControlExternalWorkspaceBridge) {
      if (matches(next)) return;
      bridge = next;
      // The new bridge's initial task is only a navigation intent and must wait for the new Root's actually visible Reporter.
      view = null;
      dirty = true;
      flush();
    },
    update(
      source: WebRemoteControlExternalWorkspaceBridge,
      next: WebRemoteControlMobileTaskView | null,
    ) {
      // The old Root's unmount callback may arrive after the new Root has mounted and must not clear the visible facts of the new bridge.
      if (!matches(source)) return;
      view = next;
      dirty = true;
      flush();
    },
    flush,
  };
}
