import type {
  RelayClientMessage, RelayServerMessage, WebRemoteControlRelayErrorCode,
  WebRemoteControlRelayRole,
} from "@zcode/shared/web-remote-relay";
import type { RelayCrypto, RelayDeviceStore, RelayPeer, RelayRegistration } from "../contract.js";
import { permitsMessage, type ConnectionPhase } from "../domain/connectionState.js";

interface Connection {
  id: string;
  peer: RelayPeer;
  phase: ConnectionPhase;
  createdAt: number;
  registeredSid?: string;
  challenge?: { nonce: string; role: WebRemoteControlRelayRole; record: RelayRegistration; expiresAt: number };
  auth?: { sid: string; role: WebRemoteControlRelayRole };
}
interface Pair { device?: Connection; terminal?: Connection; }

export function createRelayRegistry(options: {
  store: RelayDeviceStore; crypto: RelayCrypto; now: () => number; authTimeoutMs: number;
}) {
  const connections = new Map<string, Connection>();
  const pairs = new Map<string, Pair>();

  function isCurrent(connection: Connection) { return connections.get(connection.id) === connection; }

  function send(connection: Connection, message: RelayServerMessage, serialized?: string) {
    if (!isCurrent(connection)) return;
    if (!connection.peer.send(message, serialized)) disconnect(connection.id);
  }

  function status(pair: Pair) {
    return {
      type: "pair_status_ack" as const,
      pair_status: pair.device && pair.terminal ? "matched" as const : "waiting" as const,
      ...(pair.terminal ? { terminal_sid: pair.terminal.id } : {}),
      server_ts: options.now(),
    };
  }

  function disconnect(id: string) {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    connection.challenge = undefined;
    const auth = connection.auth;
    if (!auth) return;
    const pair = pairs.get(auth.sid);
    if (!pair || pair[auth.role] !== connection) return;
    delete pair[auth.role];
    if (!pair.device && !pair.terminal) pairs.delete(auth.sid);
    else {
      const other = pair.device ?? pair.terminal;
      if (other) send(other, status(pair));
    }
  }

  function fail(connection: Connection, code: WebRemoteControlRelayErrorCode, message: string, close = true) {
    send(connection, { type: "error", code, message, server_ts: options.now() });
    if (close) {
      disconnect(connection.id);
      connection.peer.close();
    }
  }

  async function receive(id: string, message: RelayClientMessage, serialized: string) {
    const connection = connections.get(id);
    if (!connection) return;
    if (!permitsMessage(connection.phase, message.type)) {
      fail(connection, "WRONG_PARAM", "Message is not valid in the current state.");
      return;
    }
    if (message.type === "device_register_init") {
      connection.phase = "registering";
      const record = await options.store.register(message.device_mid, message.pass_hash);
      if (!isCurrent(connection)) return;
      connection.registeredSid = record.sid;
      connection.phase = "new";
      send(connection, { type: "device_register_ack", device_sid: record.sid, server_ts: options.now() });
      return;
    }
    if (message.type === "auth_init") {
      if (connection.registeredSid && connection.registeredSid !== message.device_sid) {
        fail(connection, "WRONG_PARAM", "Registration identity cannot change.");
        return;
      }
      connection.phase = "loading";
      const record = await options.store.get(message.device_sid);
      if (!isCurrent(connection)) return;
      if (!record) { fail(connection, "AUTH_FAILED", "Authentication failed."); return; }
      const nonce = options.crypto.randomId();
      connection.challenge = { nonce, role: message.role, record, expiresAt: options.now() + options.authTimeoutMs };
      connection.phase = "challenge";
      send(connection, { type: "auth_challenge", nonce, server_ts: options.now() });
      return;
    }
    if (message.type === "auth_response") {
      const challenge = connection.challenge;
      connection.challenge = undefined;
      if (!challenge || challenge.expiresAt <= options.now() || challenge.record.sid !== message.device_sid ||
          !options.crypto.verify(challenge.record.key, challenge.nonce, challenge.role, challenge.record.sid, message.proof)) {
        fail(connection, "AUTH_FAILED", "Authentication failed.");
        return;
      }
      const pair = pairs.get(message.device_sid) ?? {};
      if (challenge.role === "device" && pair.device) {
        fail(connection, "KICKED", "The device already has an active connection.");
        return;
      }
      const previous = pair[challenge.role];
      connection.phase = "authenticated";
      connection.auth = { sid: message.device_sid, role: challenge.role };
      pair[challenge.role] = connection;
      pairs.set(message.device_sid, pair);
      // 新浏览器先成为唯一 owner，再关闭旧 socket；旧 close 回调不能删除新配对。
      if (previous) fail(previous, "KICKED", "Another browser replaced this connection.");
      const pairStatus = status(pair);
      send(connection, { type: "auth_ack", device_sid: message.device_sid,
        terminal_sid: pairStatus.terminal_sid, pair_status: pairStatus.pair_status, server_ts: options.now() });
      const other = challenge.role === "device" ? pair.terminal : pair.device;
      if (other) send(other, pairStatus);
      return;
    }
    const auth = connection.auth;
    const pair = auth ? pairs.get(auth.sid) : undefined;
    if (!auth || !pair || pair[auth.role] !== connection) return;
    if (message.type === "pair_status_query") {
      if (message.device_sid !== auth.sid) { fail(connection, "WRONG_PARAM", "Identity cannot change."); return; }
      send(connection, status(pair));
      return;
    }
    const other = auth.role === "device" ? pair.terminal : pair.device;
    if (!other) { fail(connection, "INTERNAL", "Peer is temporarily unavailable.", false); return; }
    send(other, message, serialized);
  }

  return {
    connect(peer: RelayPeer) {
      const id = options.crypto.randomId();
      connections.set(id, { id, peer, phase: "new", createdAt: options.now() });
      return id;
    },
    receive,
    disconnect,
    reject(id: string, code: WebRemoteControlRelayErrorCode, message: string) {
      const connection = connections.get(id);
      if (connection) fail(connection, code, message);
    },
    sweep() {
      for (const connection of connections.values()) {
        if (connection.phase !== "authenticated" && options.now() - connection.createdAt >= options.authTimeoutMs) {
          fail(connection, "AUTH_FAILED", "Authentication deadline expired.");
        }
      }
    },
    close() {
      for (const connection of [...connections.values()]) {
        disconnect(connection.id);
        connection.peer.close();
      }
    },
  };
}
