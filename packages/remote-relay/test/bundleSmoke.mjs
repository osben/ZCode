import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";

const entryPath = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "zcode-relay-bundle-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
const env = {
  ...process.env,
  ZCODE_RELAY_STORAGE_KEY: randomBytes(32).toString("base64"),
  ZCODE_RELAY_ALLOWED_ORIGINS: "https://smoke.invalid",
  ZCODE_RELAY_HOST: "127.0.0.1",
  ZCODE_RELAY_PORT: String(port),
  ZCODE_RELAY_DB_PATH: join(directory, "relay.sqlite"),
};
const key = randomBytes(32).toString("base64");
const meta = { platform: "fixture", version: "fixture", name: "fixture" };
let child;
const sockets = [];
async function start() {
  child = spawn(process.execPath, [entryPath], { env, stdio: "inherit" });
  child.on("error", (error) => {
    console.error("Child process failed:", error.code);
  });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error("Relay exited before readiness");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.status === 200) return;
    } catch (error) {
      // Connection refusal is expected until the new process starts listening.
      if (error.name !== "TypeError") throw error;
    }
    await delay(100);
  }
  throw new Error("Relay readiness deadline exceeded");
}
async function stop() {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
}
async function peer() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://smoke.invalid" });
  sockets.push(ws);
  const queue = [];
  ws.on("message", (data) => queue.push(JSON.parse(data.toString())));
  await once(ws, "open");
  return {
    send: (message) => ws.send(JSON.stringify(message)),
    async take(type) {
      for (let i = 0; i < 100; i++) {
        const error = queue.find((item) => item.type === "error");
        if (error) throw new Error("Unexpected relay protocol error: " + error.code);
        const index = queue.findIndex((item) => item.type === type);
        if (index >= 0) return queue.splice(index, 1)[0];
        await delay(20);
      }
      throw new Error("Missing relay response: " + type);
    },
  };
}
async function authenticate(peer, role, sid) {
  peer.send({ type: "auth_init", role, device_sid: sid, meta });
  const { nonce } = await peer.take("auth_challenge");
  const proof = createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");
  peer.send({ type: "auth_response", device_sid: sid, proof });
  return peer.take("auth_ack");
}
try {
  await start();
  const device = await peer();
  device.send({ type: "device_register_init", device_mid: "smoke", pass_hash: key, meta });
  const { device_sid: sid } = await device.take("device_register_ack");
  await authenticate(device, "device", sid);
  const terminal = await peer();
  assert.equal((await authenticate(terminal, "terminal", sid)).pair_status, "matched");
  terminal.send({ type: "data", payload: { fixture: "opaque-frame" } });
  assert.deepEqual((await device.take("data")).payload, { fixture: "opaque-frame" });
  sockets.splice(0).forEach((socket) => socket.terminate());
  await stop();
  await start();
  const restored = await peer();
  restored.send({ type: "device_register_init", device_mid: "smoke", pass_hash: key, meta });
  assert.equal((await restored.take("device_register_ack")).device_sid, sid);
  await authenticate(restored, "device", sid);
  console.log(
    "Bundle smoke PASS: readiness, registration, HMAC pairing, opaque forwarding, restart persistence",
  );
} finally {
  sockets.forEach((socket) => socket.terminate());
  if (child?.exitCode === null && child.signalCode === null) await stop();
  await rm(directory, { recursive: true, force: true });
}
