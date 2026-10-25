import {
  createLocalServices,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { readHttpEntryEnv } from "./entryHttpEnv.js";
import { createHttpServer, resolveHttpListenHost } from "./http.js";

async function main(): Promise<void> {
  const { port, host, staticRoot, authToken } = readHttpEntryEnv(process.env);
  // Validate before createLocalServices: its handles would keep a refused process alive.
  resolveHttpListenHost({ host, authToken });
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const topicResourcePeers = createTopicResourcePeers();
  const services = createLocalServices({
    topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
