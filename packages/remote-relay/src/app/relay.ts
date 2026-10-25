import type {
  WebRemoteControlRelayV2ErrorCode,
  WebRemoteControlRelayV2Meta,
  WebRemoteControlRelayV2OutgoingMessage,
  WebRemoteControlRelayV2PairStatus,
  WebRemoteControlRelayV2Role,
} from "@zcode/shared/web-remote-relay";
import type { RelayDeviceStore, RelayPeer } from "../contract.js";
import type { RelayTokenGrant } from "../domain/tokens.js";
import { permitsFrame, unixSeconds, type ConnectionPhase } from "../domain/connectionState.js";

type Role = WebRemoteControlRelayV2Role;
type Frame = WebRemoteControlRelayV2OutgoingMessage;
type AuthInit = Extract<Frame, { type: "auth_init" }>;

interface Connection {
  id: string;
  peer: RelayPeer;
  userId: string;
  role: Role;
  phase: ConnectionPhase;
  createdAt: number;
  deviceSid?: string;
  meta: WebRemoteControlRelayV2Meta;
}

/** The current owner of each role for one device SID. Only the registry writes it. */
interface Slot {
  device?: Connection;
  terminal?: Connection;
}

export interface RelayRegistryOptions {
  devices: Pick<RelayDeviceStore, "get">;
  now: () => number;
  authTimeoutMs: number;
  randomId: () => string;
}

export interface RelayRegistry {
  connect(peer: RelayPeer, grant: RelayTokenGrant): string;
  receive(id: string, frame: Frame): Promise<void>;
  reject(id: string, code: WebRemoteControlRelayV2ErrorCode, message: string): void;
  disconnect(id: string): void;
  sweep(): void;
  close(): void;
  isOnline(deviceSid: string): boolean;
  metaOf(deviceSid: string): WebRemoteControlRelayV2Meta;
  /** Reserves a device for deletion. Returns false when it is online. Rejects admissions until released. */
  reserveDeletion(deviceSid: string): boolean;
  releaseDeletion(deviceSid: string): void;
}

function pairStatus(slot: Slot): WebRemoteControlRelayV2PairStatus {
  return slot.device && slot.terminal ? "matched" : "waiting";
}

/** Meta is device self-report; keep only the three declared string fields. */
function cleanMeta(meta: WebRemoteControlRelayV2Meta | undefined): WebRemoteControlRelayV2Meta {
  if (!meta) return {};
  return {
    ...(meta.name === undefined ? {} : { name: meta.name }),
    ...(meta.platform === undefined ? {} : { platform: meta.platform }),
    ...(meta.version === undefined ? {} : { version: meta.version }),
  };
}

/**
 * Sole owner of connections and the `(SID, role)` slots. Every transition that replaces or
 * removes an owner checks the exact connection identity, so a late close cannot drop a newer owner.
 */
export function createRelayRegistry(options: RelayRegistryOptions): RelayRegistry {
  const connections = new Map<string, Connection>();
  const slots = new Map<string, Slot>();
  // Deletion bookkeeping. `epochs` only grows, so an admission that read the record before a
  // delete finished still sees a changed epoch and is rejected.
  const inflightDeletions = new Set<string>();
  const epochs = new Map<string, number>();

  const isCurrent = (connection: Connection) => connections.get(connection.id) === connection;
  const nowSeconds = () => unixSeconds(options.now());

  function send(connection: Connection, message: Record<string, unknown>) {
    if (!isCurrent(connection)) return;
    if (!connection.peer.send(message)) disconnect(connection.id);
  }

  /** Sends a protocol error when given, then removes the connection and closes its socket. */
  function drop(
    connection: Connection,
    error?: { code: WebRemoteControlRelayV2ErrorCode; message: string },
  ) {
    if (error && isCurrent(connection)) {
      connection.peer.send({
        type: "error",
        code: error.code,
        message: error.message,
        server_ts: nowSeconds(),
      });
    }
    disconnect(connection.id);
    connection.peer.close();
  }

  function fail(connection: Connection, code: WebRemoteControlRelayV2ErrorCode, message: string) {
    drop(connection, { code, message });
  }

  function disconnect(id: string) {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    if (connection.phase !== "authenticated" || !connection.deviceSid) return;
    const sid = connection.deviceSid;
    const slot = slots.get(sid);
    // A replaced socket finds another owner here and must leave the slot untouched.
    if (!slot || slot[connection.role] !== connection) return;
    delete slot[connection.role];
    const other = connection.role === "device" ? slot.terminal : slot.device;
    if (connection.role === "device" && other) {
      send(other, {
        type: "pair_status_ack",
        terminal_sid: "",
        pair_status: "waiting",
        server_ts: nowSeconds(),
      });
      fail(other, "DEVICE_OFFLINE", "The device is offline.");
    } else if (other) {
      send(other, {
        type: "pair_status_ack",
        terminal_sid: "",
        pair_status: "waiting",
        server_ts: nowSeconds(),
      });
    }
    if (!slot.device && !slot.terminal) slots.delete(sid);
  }

  async function authenticate(connection: Connection, frame: AuthInit) {
    const sid = frame.device_sid;
    if (inflightDeletions.has(sid)) {
      fail(connection, "AUTH_FAILED", "Authentication failed.");
      return;
    }
    const epochBefore = epochs.get(sid) ?? 0;
    const record = await options.devices.get(sid);
    if (!isCurrent(connection)) return;
    // Everything below is synchronous: a deletion reservation cannot interleave with the slot write.
    if (
      !record ||
      record.userId !== connection.userId ||
      inflightDeletions.has(sid) ||
      (epochs.get(sid) ?? 0) !== epochBefore
    ) {
      fail(connection, "AUTH_FAILED", "Authentication failed.");
      return;
    }
    const slot = slots.get(sid) ?? {};
    const previous = slot[connection.role];
    connection.phase = "authenticated";
    connection.deviceSid = sid;
    connection.meta = connection.role === "device" ? cleanMeta(frame.meta) : {};
    slot[connection.role] = connection;
    slots.set(sid, slot);
    // Bind the replacement before closing the old socket; the old close finds the slot already changed.
    if (previous) fail(previous, "KICKED", "Another browser replaced this connection.");
    const status = pairStatus(slot);
    send(connection, {
      type: "auth_ack",
      device_sid: sid,
      terminal_sid: connection.role === "terminal" ? connection.id : "",
      pair_status: status,
      server_ts: nowSeconds(),
    });
    const other = connection.role === "device" ? slot.terminal : slot.device;
    if (other) {
      send(other, {
        type: "pair_status_ack",
        terminal_sid: "",
        pair_status: status,
        server_ts: nowSeconds(),
      });
    }
  }

  return {
    connect(peer, grant) {
      const id = options.randomId();
      connections.set(id, {
        id,
        peer,
        userId: grant.userId,
        role: grant.role,
        phase: "pending",
        createdAt: options.now(),
        meta: {},
      });
      return id;
    },
    async receive(id, frame) {
      const connection = connections.get(id);
      if (!connection) return;
      if (!permitsFrame(connection.phase, frame.type)) {
        fail(connection, "WRONG_PARAM", "Frame is not valid in the current state.");
        return;
      }
      if (frame.type === "auth_init") {
        await authenticate(connection, frame);
        return;
      }
      const sid = connection.deviceSid;
      const slot = sid ? slots.get(sid) : undefined;
      if (!sid || !slot || slot[connection.role] !== connection) return;
      if (frame.type === "pair_status_query") {
        send(connection, {
          type: "pair_status_ack",
          terminal_sid: connection.role === "device" && slot.terminal ? slot.terminal.id : "",
          pair_status: pairStatus(slot),
          server_ts: nowSeconds(),
        });
        return;
      }
      const other = connection.role === "device" ? slot.terminal : slot.device;
      if (!other) {
        send(connection, {
          type: "error",
          code: "INTERNAL",
          message: "Peer is temporarily unavailable.",
          server_ts: nowSeconds(),
        });
        return;
      }
      // Forward only the declared fields: the relay never copies client timestamps or extra keys.
      send(other, { type: "data", payload: frame.payload, server_ts: nowSeconds() });
    },
    reject(id, code, message) {
      const connection = connections.get(id);
      if (connection) fail(connection, code, message);
    },
    disconnect,
    sweep() {
      // Map iteration tolerates deleting the current entry, which fail()/disconnect() do here.
      for (const connection of connections.values()) {
        if (
          connection.phase === "pending" &&
          options.now() - connection.createdAt >= options.authTimeoutMs
        ) {
          fail(connection, "AUTH_FAILED", "Authentication deadline expired.");
        }
      }
    },
    close() {
      for (const connection of connections.values()) drop(connection);
    },
    isOnline(deviceSid) {
      return Boolean(slots.get(deviceSid)?.device);
    },
    metaOf(deviceSid) {
      return slots.get(deviceSid)?.device?.meta ?? {};
    },
    reserveDeletion(deviceSid) {
      if (slots.get(deviceSid)?.device) return false;
      inflightDeletions.add(deviceSid);
      epochs.set(deviceSid, (epochs.get(deviceSid) ?? 0) + 1);
      return true;
    },
    releaseDeletion(deviceSid) {
      inflightDeletions.delete(deviceSid);
    },
  };
}
