import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";

// Smoke test of the bundled relay (dist/entry.js): config, login exchange, HTTP, WebSocket pairing, restart.
const entryPath = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "zcode-relay-bundle-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

const issuer = "https://identity.smoke.invalid";
const identity = generateKeyPairSync("ed25519");
const relaySigning = generateKeyPairSync("ed25519");
const env = {
  ...process.env,
  ZCODE_RELAY_ALLOWED_ORIGINS: "https://smoke.invalid",
  ZCODE_RELAY_HOST: "127.0.0.1",
  ZCODE_RELAY_PORT: String(port),
  ZCODE_RELAY_DB_PATH: join(directory, "relay.sqlite"),
  ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS: JSON.stringify([
    {
      ...relaySigning.privateKey.export({ format: "jwk" }),
      kid: "smoke-relay-1",
    },
  ]),
  ZCODE_REMOTE_RELAY_IDENTITY_ISSUER: issuer,
  ZCODE_REMOTE_RELAY_IDENTITY_JWKS: JSON.stringify({
    keys: [{ ...identity.publicKey.export({ format: "jwk" }), kid: "smoke-login-1" }],
  }),
};

function loginToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: "smoke-login-1" })}.${encode({ iss: issuer, sub: "smoke-user", iat: now, exp: now + 600 })}`;
  return `${input}.${sign(null, Buffer.from(input), identity.privateKey).toString("base64url")}`;
}

const base = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/api/v1/remote/ws2`;
let child;
const sockets = [];

async function start() {
  child = spawn(process.execPath, [entryPath], { env, stdio: "inherit" });
  child.on("error", (error) => console.error("Child process failed:", error.code));
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error("Relay exited before readiness");
    try {
      const response = await fetch(`${base}/readyz`);
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

async function api(method, path, { bearer, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  assert.equal(json.code, 0, `${method} ${path} failed: ${json.msg}`);
  return json.data;
}

async function socket(bearer, role, deviceSid) {
  const issued = await api("POST", "/api/v1/remote/token", {
    bearer,
    body: { role },
  });
  const ws = new WebSocket(`${wsUrl}?token=${issued.token}`, {
    origin: "https://smoke.invalid",
  });
  sockets.push(ws);
  const queue = [];
  ws.on("message", (data) => queue.push(JSON.parse(data.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth_init", device_sid: deviceSid }));
  return {
    ws,
    async take(type) {
      for (let i = 0; i < 100; i++) {
        const error = queue.find((item) => item.type === "error");
        if (error) throw new Error(`Unexpected relay protocol error: ${error.code}`);
        const index = queue.findIndex((item) => item.type === type);
        if (index >= 0) return queue.splice(index, 1)[0];
        await delay(20);
      }
      throw new Error(`Missing relay response: ${type}`);
    },
  };
}

try {
  await start();
  const jwt = (
    await api("POST", "/api/v1/remote/session", {
      body: { identity_token: loginToken() },
    })
  ).jwt;
  const device = await api("POST", "/api/v1/remote/device", {
    bearer: jwt,
    body: { device_mid: "smoke" },
  });
  const sid = device.device_sid;

  const deviceSocket = await socket(jwt, "device", sid);
  assert.equal((await deviceSocket.take("auth_ack")).pair_status, "waiting");
  const terminalSocket = await socket(jwt, "terminal", sid);
  assert.equal((await terminalSocket.take("auth_ack")).pair_status, "matched");
  terminalSocket.ws.send(JSON.stringify({ type: "data", payload: { fixture: "opaque-frame" } }));
  assert.deepEqual((await deviceSocket.take("data")).payload, {
    fixture: "opaque-frame",
  });

  sockets.splice(0).forEach((item) => item.terminate());
  await stop();
  await start();
  const restartedJwt = (
    await api("POST", "/api/v1/remote/session", {
      body: { identity_token: loginToken() },
    })
  ).jwt;
  const listed = await api("GET", "/api/v1/remote/device", {
    bearer: restartedJwt,
  });
  assert.equal(listed[0].device_sid, sid);
  const restored = await socket(restartedJwt, "device", sid);
  assert.equal((await restored.take("auth_ack")).pair_status, "waiting");
  sockets.splice(0).forEach((item) => item.terminate());
  await stop();

  // Second leg: the same bundle in device-key mode, with the account variables removed.
  delete env.ZCODE_REMOTE_RELAY_IDENTITY_ISSUER;
  delete env.ZCODE_REMOTE_RELAY_IDENTITY_JWKS;
  env.ZCODE_REMOTE_RELAY_IDENTITY_MODE = "device-key";
  env.ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET = "smoke-enrollment-secret-0123456789abcdef";
  await start();
  const deviceKey = generateKeyPairSync("ed25519");
  const publicKey = deviceKey.publicKey.export({ format: "jwk" }).x;
  const exchangeBody = (secret) => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("base64url");
    const signed = `zcode-relay-device-session-v1\nzcode-remote-relay\n${publicKey}\n${ts}\n${nonce}`;
    const signature = sign(null, Buffer.from(signed), deviceKey.privateKey).toString("base64url");
    return {
      device_key: { public_key: publicKey, ts, nonce, signature },
      ...(secret ? { enrollment_secret: secret } : {}),
    };
  };
  const enrolled = await api("POST", "/api/v1/remote/session", {
    body: exchangeBody(env.ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET),
  });
  const again = await api("POST", "/api/v1/remote/session", {
    body: exchangeBody(),
  });
  assert.ok(again.jwt);
  const pairing = await api("POST", "/api/v1/remote/pairing", {
    bearer: enrolled.jwt,
    body: {},
  });
  const phone = await api("POST", "/api/v1/remote/session", {
    body: { pairing_code: pairing.code },
  });
  const deviceKeyDevice = await api("POST", "/api/v1/remote/device", {
    bearer: enrolled.jwt,
    body: { device_mid: "smoke-device-key" },
  });
  const phoneList = await api("GET", "/api/v1/remote/device", {
    bearer: phone.jwt,
  });
  assert.equal(phoneList[0].device_sid, deviceKeyDevice.device_sid);
  const oldModeJwt = await fetch(`${base}/api/v1/remote/device`, {
    headers: { Authorization: `Bearer ${restartedJwt}` },
  });
  assert.equal(oldModeJwt.status, 401);
  console.log(
    "Bundle smoke PASS: readiness, login exchange, device registration, V2 pairing, opaque forwarding, restart persistence, device-key enrollment and pairing code",
  );
} finally {
  sockets.forEach((item) => item.terminate());
  if (child?.exitCode === null && child.signalCode === null) await stop();
  await rm(directory, { recursive: true, force: true });
}
