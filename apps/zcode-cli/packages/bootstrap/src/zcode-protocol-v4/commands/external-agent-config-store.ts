// Session config of an external ACP agent as the v4 command layer sees it (specs/acp-agent-runtime.md
// "S6"). The worker's session binding store (fork_acp_session_binding) implements it; the handler never
// reaches a running agent through it.
import type { ExternalAgentConfigOption } from "@zcode/contracts";

export interface V4ExternalAgentConfigStore {
  /** The binding's config, or the pending choices of a session whose first turn has not run. */
  readConfig(sessionId: string): Promise<{
    readonly agentId: string | undefined;
    readonly offered: readonly ExternalAgentConfigOption[] | undefined;
    readonly choices: Readonly<Record<string, string>>;
  }>;
  /** The last options the agent offered (S6 readiness catalog); undefined when it was never run or tested. */
  readCatalog(agentId: string): Promise<readonly ExternalAgentConfigOption[] | undefined>;
  writeOffered(sessionId: string, options: readonly ExternalAgentConfigOption[]): Promise<void>;
  writeChoice(sessionId: string, agentId: string, configId: string, value: string): Promise<void>;
}
