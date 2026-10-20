import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

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
  | { id: number; method: "register"; userId: string; deviceMid: string; createdAt: number }
  | { id: number; method: "list"; userId: string }
  | { id: number; method: "get"; deviceSid: string }
  | { id: number; method: "remove"; deviceSid: string }
  | { id: number; method: "close" };

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
      port.postMessage({ id: request.id, result: { removed: result.changes === 1 } });
      return;
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
    port.postMessage({ id: request.id, error: "Device store operation failed." });
  }
});
