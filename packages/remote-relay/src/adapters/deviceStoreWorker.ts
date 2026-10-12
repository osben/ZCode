import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const port = parentPort;
if (!port) throw new Error("Registration worker requires a parent port.");
const key = Buffer.from(workerData.storageKey, "base64");
let database: DatabaseSync;

function decrypt(row: Record<string, unknown>): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv as Uint8Array));
  decipher.setAAD(Buffer.from(row.sid as string));
  decipher.setAuthTag(Buffer.from(row.tag as Uint8Array));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext as Uint8Array)),
    decipher.final(),
  ]).toString("utf8");
}

try {
  database = new DatabaseSync(workerData.path, { timeout: 1000 });
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS registrations (
      sid TEXT PRIMARY KEY, mid TEXT NOT NULL, fingerprint TEXT NOT NULL,
      iv BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL,
      created_at INTEGER NOT NULL, authenticated_at INTEGER,
      UNIQUE(mid, fingerprint)
    ) STRICT;
  `);
  const existing = database.prepare("SELECT * FROM registrations LIMIT 1").get();
  if (existing) decrypt(existing);
  port.postMessage({ type: "ready" });
} catch {
  port.postMessage({ type: "startup-error" });
  port.close();
}

port.on(
  "message",
  (request: {
    id: number;
    method: "register" | "get" | "touch" | "close";
    mid?: string;
    key?: string;
    sid?: string;
  }) => {
    try {
      if (request.method === "close") {
        database.close();
        port.postMessage({ id: request.id, result: null });
        port.close();
        return;
      }
      if (request.method === "get") {
        const row = database.prepare("SELECT * FROM registrations WHERE sid = ?").get(request.sid!);
        if (!row) {
          port.postMessage({ id: request.id, result: null });
          return;
        }
        const plaintext = decrypt(row);
        port.postMessage({ id: request.id, result: { sid: row.sid, key: plaintext } });
        return;
      }
      if (request.method === "touch") {
        // A SID lookup must not count an abandoned challenge or invalid proof as authentication.
        const result = database
          .prepare("UPDATE registrations SET authenticated_at = ? WHERE sid = ?")
          .run(Date.now(), request.sid!);
        if (result.changes !== 1) throw new Error("Registration does not exist.");
        port.postMessage({ id: request.id, result: null });
        return;
      }
      const fingerprint = createHash("sha256").update(request.key!).digest("hex");
      const existing = database
        .prepare("SELECT * FROM registrations WHERE mid = ? AND fingerprint = ?")
        .get(request.mid!, fingerprint);
      if (existing) {
        port.postMessage({ id: request.id, result: { sid: existing.sid, key: decrypt(existing) } });
        return;
      }
      const count = database.prepare("SELECT count(*) AS count FROM registrations").get()!
        .count as number;
      if (count >= workerData.maxRecords) throw new Error("Registration capacity exceeded.");
      const sid = randomUUID();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(sid));
      const ciphertext = Buffer.concat([cipher.update(request.key!, "utf8"), cipher.final()]);
      database
        .prepare(
          "INSERT INTO registrations (sid, mid, fingerprint, iv, ciphertext, tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sid, request.mid!, fingerprint, iv, ciphertext, cipher.getAuthTag(), Date.now());
      port.postMessage({ id: request.id, result: { sid, key: request.key } });
    } catch {
      // Return fixed errors so database paths, registration keys and ciphertext cannot leak.
      port.postMessage({ id: request.id, error: "Registration store operation failed." });
    }
  },
);
