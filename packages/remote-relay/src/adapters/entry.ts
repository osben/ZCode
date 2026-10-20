import { readRelayConfig } from "./config.js";
import { createRelayDeviceStore } from "./deviceStore.js";
import { createRelaySessionService } from "./session.js";
import { createRelayServer } from "./nodeServer.js";
import type { RelayLogger } from "../contract.js";

const log = (level: string, event: string) => {
  process.stdout.write(
    JSON.stringify({ scope: "remote-relay", level, event, time: new Date().toISOString() }) + "\n",
  );
};
const logger: RelayLogger = {
  info: (event) => log("info", event),
  warn: (event) => log("warn", event),
  error: (event) => log("error", event),
};

async function main() {
  const config = readRelayConfig(process.env);
  // Key material is validated before the database opens, so a bad key set never starts a half-up relay.
  const session = createRelaySessionService({
    signingKeys: config.session.signingKeys,
    ttlSeconds: config.session.ttlSeconds,
    identity: config.session.identity,
    now: Date.now,
  });
  const store = await createRelayDeviceStore(config.store);
  const server = await createRelayServer({ ...config.server, store, session, logger });
  logger.info("started");
  let shutdown: Promise<void> | undefined;
  const stop = () => {
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
