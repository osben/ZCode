import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

const port = parentPort;
if (!port) throw new Error("Device store worker requires a parent port.");
let database: DatabaseSync;

interface DeviceRow {
  device_sid: string;
  user_id: string;
  device_mid: string;
  created_at: number;
}

type Request =
  | {
      id: number;
      method: "register";
      userId: string;
      deviceMid: string;
      createdAt: number;
      maxForUser?: number;
    }
  | { id: number; method: "list"; userId: string }
  | { id: number; method: "get"; deviceSid: string }
  | { id: number; method: "remove"; deviceSid: string }
  | { id: number; method: "keyExists"; publicKey: string }
  | {
      id: number;
      method: "enrollKey";
      publicKey: string;
      createdAt: number;
      tier: "owner" | "open";
    }
  | { id: number; method: "touchKey"; publicKey: string; seenAt: number }
  | {
      id: number;
      method: "recordUsage";
      rows: {
        identity: string;
        lastSeen: number;
        day: number;
        dayBytes: number;
      }[];
    }
  | { id: number; method: "sweepIdle"; cutoff: number }
  | { id: number; method: "close" };

/** The relay user id derived from a raw Ed25519 public key; must match session.ts. */
function identityOf(publicKey: string) {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("base64url");
  return `dk:${digest}`;
}

function inTransaction<T>(action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function toRecord(row: DeviceRow) {
  return {
    deviceSid: row.device_sid,
    userId: row.user_id,
    deviceMid: row.device_mid,
    createdAt: row.created_at,
  };
}

try {
  database = new DatabaseSync(workerData.path, { timeout: 1000 });
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS relay_devices (
      device_sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_mid TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS relay_devices_user ON relay_devices(user_id);
    CREATE TABLE IF NOT EXISTS fork_relay_device_keys (
      public_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fork_relay_identity_usage (
      public_key TEXT PRIMARY KEY,
      identity TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      day INTEGER NOT NULL,
      day_bytes INTEGER NOT NULL
    ) STRICT;
  `);
  port.postMessage({ type: "ready" });
} catch {
  port.postMessage({ type: "startup-error" });
  port.close();
}

port.on("message", (request: Request) => {
  try {
    if (request.method === "close") {
      database.close();
      port.postMessage({ id: request.id, result: null });
      port.close();
      return;
    }
    if (request.method === "keyExists") {
      // A key without a usage row predates open enrollment: every such key was enrolled with the secret.
      const row = database
        .prepare(
          `SELECT u.tier AS tier FROM fork_relay_device_keys k
           LEFT JOIN fork_relay_identity_usage u ON u.public_key = k.public_key
           WHERE k.public_key = ?`,
        )
        .get(request.publicKey) as { tier: string | null } | undefined;
      const openKeys = database
        .prepare("SELECT count(*) AS count FROM fork_relay_identity_usage WHERE tier = 'open'")
        .get()!.count as number;
      port.postMessage({
        id: request.id,
        result: {
          openKeys,
          ...(row === undefined ? {} : { tier: row.tier === "open" ? "open" : "owner" }),
        },
      });
      return;
    }
    if (request.method === "enrollKey") {
      inTransaction(() => {
        const known = database
          .prepare("SELECT 1 AS present FROM fork_relay_device_keys WHERE public_key = ?")
          .get(request.publicKey);
        if (known !== undefined) return;
        const count = database
          .prepare("SELECT count(*) AS count FROM fork_relay_device_keys")
          .get()!.count as number;
        if (count >= workerData.maxRecords) throw new Error("Device key capacity exceeded.");
        if (request.tier === "open") {
          const open = database
            .prepare("SELECT count(*) AS count FROM fork_relay_identity_usage WHERE tier = 'open'")
            .get()!.count as number;
          if (open >= workerData.maxEnrolledKeys) throw new Error("Open key capacity exceeded.");
        }
        database
          .prepare("INSERT INTO fork_relay_device_keys (public_key, created_at) VALUES (?, ?)")
          .run(request.publicKey, request.createdAt);
        database
          .prepare(
            "INSERT INTO fork_relay_identity_usage (public_key, identity, tier, last_seen, day, day_bytes) VALUES (?, ?, ?, ?, ?, 0)",
          )
          .run(
            request.publicKey,
            identityOf(request.publicKey),
            request.tier,
            request.createdAt,
            Math.floor(request.createdAt / 86_400),
          );
      });
      port.postMessage({ id: request.id, result: null });
      return;
    }
    if (request.method === "touchKey") {
      database
        .prepare(
          "UPDATE fork_relay_identity_usage SET last_seen = max(last_seen, ?) WHERE public_key = ?",
        )
        .run(request.seenAt, request.publicKey);
      port.postMessage({ id: request.id, result: null });
      return;
    }
    if (request.method === "recordUsage") {
      inTransaction(() => {
        const update = database.prepare(
          "UPDATE fork_relay_identity_usage SET last_seen = max(last_seen, ?), day = ?, day_bytes = ? WHERE identity = ?",
        );
        for (const row of request.rows)
          update.run(row.lastSeen, row.day, row.dayBytes, row.identity);
      });
      port.postMessage({ id: request.id, result: null });
      return;
    }
    if (request.method === "sweepIdle") {
      // Only open-tier keys expire; owner keys and legacy keys (no usage row) never do.
      const removed = inTransaction(() => {
        const stale = database
          .prepare(
            "SELECT public_key, identity FROM fork_relay_identity_usage WHERE tier = 'open' AND last_seen < ?",
          )
          .all(request.cutoff) as { public_key: string; identity: string }[];
        for (const row of stale) {
          database.prepare("DELETE FROM relay_devices WHERE user_id = ?").run(row.identity);
          database
            .prepare("DELETE FROM fork_relay_device_keys WHERE public_key = ?")
            .run(row.public_key);
          database
            .prepare("DELETE FROM fork_relay_identity_usage WHERE public_key = ?")
            .run(row.public_key);
        }
        return stale.length;
      });
      port.postMessage({ id: request.id, result: { removed } });
      return;
    }
    if (request.method === "list") {
      const rows = database
        .prepare("SELECT * FROM relay_devices WHERE user_id = ? ORDER BY created_at, device_sid")
        .all(request.userId) as unknown as DeviceRow[];
      port.postMessage({ id: request.id, result: rows.map(toRecord) });
      return;
    }
    if (request.method === "get") {
      const row = database
        .prepare("SELECT * FROM relay_devices WHERE device_sid = ?")
        .get(request.deviceSid) as unknown as DeviceRow | undefined;
      port.postMessage({ id: request.id, result: row ? toRecord(row) : null });
      return;
    }
    if (request.method === "remove") {
      const result = database
        .prepare("DELETE FROM relay_devices WHERE device_sid = ?")
        .run(request.deviceSid);
      port.postMessage({
        id: request.id,
        result: { removed: result.changes === 1 },
      });
      return;
    }
    if (request.maxForUser !== undefined) {
      const owned = database
        .prepare("SELECT count(*) AS count FROM relay_devices WHERE user_id = ?")
        .get(request.userId)!.count as number;
      if (owned >= request.maxForUser) {
        port.postMessage({ id: request.id, result: { limit: true } });
        return;
      }
    }
    const count = database.prepare("SELECT count(*) AS count FROM relay_devices").get()!
      .count as number;
    if (count >= workerData.maxRecords) throw new Error("Device capacity exceeded.");
    const deviceSid = randomUUID();
    database
      .prepare(
        "INSERT INTO relay_devices (device_sid, user_id, device_mid, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(deviceSid, request.userId, request.deviceMid, request.createdAt);
    port.postMessage({
      id: request.id,
      result: {
        deviceSid,
        userId: request.userId,
        deviceMid: request.deviceMid,
        createdAt: request.createdAt,
      },
    });
  } catch {
    // Fixed message: database paths and identifiers never leak through the worker boundary.
    port.postMessage({
      id: request.id,
      error: "Device store operation failed.",
    });
  }
});
