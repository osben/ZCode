/**
 * Worker-scoped ACP agents (specs/acp-agent-runtime.md "Chat delegation (phase 4)" and "S5"): one pool of
 * resident agent processes and the turn host that drives them. Bindings of ZCode sessions to ACP sessions
 * live in the session database, so a cold start can load the earlier ACP session.
 */
import type { Logger } from "@zcode/contracts";
import { createForkAcpSessionBindingStore } from "@zcode/adapters/storage";
import { createAcpExternalAgentHost, type AcpAgentRecordSource, type ExternalAgentTurnHost } from "./acp-external-agent-host.js";
import { AcpSessionPool, acpRuntimeLoggerFrom } from "./acp-session-pool.js";
import type { AcpSessionConfigStore } from "./acp-config-reconcile.js";

export interface AcpWorkerAgents {
  readonly pool: AcpSessionPool;
  readonly externalAgents: ExternalAgentTurnHost;
  /** Offered options and chosen values per session, shared with the v4 command handler (S6). */
  readonly config: AcpSessionConfigStore;
}

export function createAcpWorkerAgents(options: {
  readonly records: AcpAgentRecordSource;
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
  });
  return { pool, externalAgents, config: bindings };
}
