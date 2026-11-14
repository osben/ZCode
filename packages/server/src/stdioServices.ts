import {
  createLocalServices,
  getAppConfigDir,
  type ZCodeAgentCommandResolver,
} from "@zcode/services/node";
import { createServerCredentialCipher } from "@zcode/shared/credential-security";
import { join } from "node:path";
import type { IChannel } from "@zcode/rpc";
import {
  parseServiceAuthorityMode,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";

export interface CreateStdioServicesOptions {
  topicResourceRelayChannel?: () => IChannel;
  env?: Record<string, string | undefined>;
  zcodeBuiltinProviderConfigFilePath: string;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
}

export interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
}

export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ZCODE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
  };
}

export async function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // The stdio entry must also verify storage before it publishes ready, so a failure
  // cannot surface after sync has already started.
  const credentialCipherProvider = await createServerCredentialCipher({
    filePath: join(getAppConfigDir(), "credentials.json"),
    env,
  });
  // Remote Desktop presentation capabilities must enter the Services derivation chain through the authority mode received by the stdio entry point.
  // The test-injected resolver only observes the final command before spawn; it does not change the production default resolver.
  const services = createLocalServices({
    credentialCipherProvider,
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    serviceAuthorityMode: authorityModeParseResult.mode,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    remoteAgentNetwork,
  });

  return {
    authorityModeParseResult,
    services,
  };
}
