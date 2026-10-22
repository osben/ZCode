// Session config of an external ACP agent as the v4 command layer sees it (specs/acp-agent-runtime.md
// "S6"). The worker's session binding store (fork_acp_session_binding) implements it; the handler never
// reaches a running agent through it.
import type { ExternalAgentConfigOption } from "@zcode/contracts";

export interface V4ExternalAgentConfigStore {
  readConfig(sessionId: string): Promise<{
    readonly agentId: string | undefined;
    readonly offered: readonly ExternalAgentConfigOption[] | undefined;
    readonly choices: Readonly<Record<string, string>>;
  }>;
  writeOffered(sessionId: string, options: readonly ExternalAgentConfigOption[]): Promise<void>;
  writeChoice(sessionId: string, configId: string, value: string): Promise<void>;
}
