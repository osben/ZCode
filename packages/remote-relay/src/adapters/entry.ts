import { readRelayConfig } from "./config.js";
import { createRelayDeviceStore } from "./deviceStore.js";
import { createRelaySessionService, type DeviceKeyIdentityConfig } from "./session.js";
import { createRelayServer } from "./nodeServer.js";
import type { RelayDeviceKeyStore, RelayLogger } from "../contract.js";

const log = (level: string, event: string) => {
  process.stdout.write(
    JSON.stringify({
      scope: "remote-relay",
      level,
      event,
      time: new Date().toISOString(),
    }) + "\n",
  );
};
const logger: RelayLogger = {
  info: (event) => log("info", event),
  warn: (event) => log("warn", event),
  error: (event) => log("error", event),
};

function deviceKeyIdentity(
  identity: ReturnType<typeof readRelayConfig>["session"]["identity"],
  keys: RelayDeviceKeyStore,
): DeviceKeyIdentityConfig {
  if (identity.mode !== "device-key") throw new Error("Device-key identity is not configured.");
  return {
    mode: "device-key",
    ...(identity.enrollmentSecret === undefined
      ? {}
      : { enrollmentSecret: identity.enrollmentSecret }),
    enrollment: identity.enrollment,
    keys,
  };
}

async function main() {
  const config = readRelayConfig(process.env);
  for (const warning of config.warnings) logger.warn(warning);
  const identity = config.session.identity;
  // Key material is validated before the database opens, so a bad key set never starts a half-up relay.
  // Device-key mode needs the store, so its service is built right after the (already validated) config.
  const zaiSession =
    identity.mode === "zai-jwt"
      ? createRelaySessionService({
          signingKeys: config.session.signingKeys,
          ttlSeconds: config.session.ttlSeconds,
          identity,
          now: Date.now,
        })
      : undefined;
  const store = await createRelayDeviceStore(config.store);
  const session =
    zaiSession ??
    createRelaySessionService({
      signingKeys: config.session.signingKeys,
      ttlSeconds: config.session.ttlSeconds,
      identity: deviceKeyIdentity(identity, store),
      now: Date.now,
    });
  // Idle open-tier keys expire so abandoned installs do not hold enrollment capacity forever.
  const sweepIdle = () =>
    store
      .sweepIdleKeys(Math.floor(Date.now() / 1000) - config.store.keyIdleExpiryDays * 86_400)
      .then((removed) => removed > 0 && logger.info("idle-keys-expired"))
      .catch(() => logger.warn("idle-key-sweep-failed"));
  void sweepIdle();
  const idleTimer = setInterval(() => void sweepIdle(), 3_600_000);
  idleTimer.unref();
  const server = await createRelayServer({
    ...config.server,
    store,
    session,
    logger,
  });
  logger.info("started");
  let shutdown: Promise<void> | undefined;
  const stop = () => {
    clearInterval(idleTimer);
    shutdown ??= server.close();
    shutdown
      .then(() => logger.info("stopped"))
      .catch(() => {
        logger.error("shutdown-failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  // Startup errors carry names of configuration variables, never their values.
  logger.error(`startup-failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
