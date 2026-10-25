/**
 * Worker-scoped ACP agents (specs/acp-agent-runtime.md "Chat delegation (phase 4)" and "S5"): one pool of
 * resident agent processes and the turn host that drives them. Bindings of ZCode sessions to ACP sessions
 * live in the session database, so a cold start can load the earlier ACP session.
 */
import type { ExternalAgentConfigOption, Logger } from "@zcode/contracts";
import { createForkAcpSessionBindingStore } from "@zcode/adapters/storage";
import type { V4ExternalAgentConfigStore } from "../zcode-protocol-v4/commands/external-agent-config-store.js";
import { createAcpExternalAgentHost, type AcpAgentRecordSource, type ExternalAgentTurnHost } from "./acp-external-agent-host.js";
import { AcpSessionPool, acpRuntimeLoggerFrom } from "./acp-session-pool.js";

/** The per-agent catalog of offered options (S6 readiness); the provider package's file store implements it. */
export interface AcpAgentCatalogPort {
  readAgent(agentId: string): Promise<readonly ExternalAgentConfigOption[] | undefined>;
  write(agentId: string, options: readonly ExternalAgentConfigOption[]): Promise<unknown>;
}

export interface AcpWorkerAgents {
  readonly pool: AcpSessionPool;
  readonly externalAgents: ExternalAgentTurnHost;
  /** Offered options, chosen values and the agent catalog, shared with the v4 command handler and the seed (S6). */
  readonly config: V4ExternalAgentConfigStore;
}

export function createAcpWorkerAgents(options: {
  readonly records: AcpAgentRecordSource;
  readonly catalog: AcpAgentCatalogPort;
  readonly logger: Logger;
  readonly sessionDbPath: string;
}): AcpWorkerAgents {
  const bindings = createForkAcpSessionBindingStore(options.sessionDbPath);
  const pool = new AcpSessionPool({
    logger: acpRuntimeLoggerFrom(options.logger),
    bindings,
  });
  const externalAgents = createAcpExternalAgentHost({
    records: options.records,
    pool,
    logger: options.logger,
    config: bindings,
    catalog: options.catalog,
  });
  const config: V4ExternalAgentConfigStore = {
    readConfig: (sessionId) => bindings.readConfig(sessionId),
    readCatalog: (agentId) => options.catalog.readAgent(agentId),
    writeOffered: (sessionId, offered) => bindings.writeOffered(sessionId, offered),
    writeChoice: (sessionId, agentId, configId, value) =>
      bindings.writeChoice(sessionId, agentId, configId, value),
  };
  return { pool, externalAgents, config };
}
