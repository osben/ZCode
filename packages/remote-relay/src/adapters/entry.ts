import { readRelayConfig } from "./config.js";
import { createRelayDeviceStore } from "./deviceStore.js";
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
  const store = await createRelayDeviceStore(config.store);
  const server = await createRelayServer({ ...config.server, store, logger });
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

main().catch(() => {
  logger.error("startup-failed");
  process.exitCode = 1;
});
