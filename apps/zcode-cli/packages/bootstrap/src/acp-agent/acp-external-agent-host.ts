/**
 * Turn drivers of ACP agent providers (specs/acp-agent-runtime.md "Chat delegation (phase 4)").
 *
 * The composition root binds each `acp-agent` Model to a driver here. A driver reads the agent's
 * sidecar record on every turn (launch config is never cached in the Registry), acquires the
 * session's resident process from the pool, and maps the ACP prompt onto the turn contract:
 * message and thought chunks stream out, the prompt's stop reason and usage come back, and every
 * failure becomes an `ExternalAgentTurnError` with a user-facing message.
 */
import {
  ACP_AGENT_DEFINITIONS,
  AcpAgentDiedError,
  type AcpRuntimeEvent,
  type ContentBlock,
} from "@zcode/acp-agent-runtime";
import {
  ExternalAgentTurnError,
  type ExternalAgentPromptBlock,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
  type ModelUsage,
} from "@zcode/contracts";
import type { AcpPoolRuntime, AcpSessionPool } from "./acp-session-pool.js";

/** Auth failures are recognized by the agent's own wording; the runtime never inspects text otherwise. */
const AUTH_FAILURE_PATTERN = /\bauth(?:entication|orization|orized)?\b|sign[ -]?in|log[ -]?in|unauthori[sz]ed|credential/i;

/** Read-only view of the fork sidecar: launch config is re-read on each turn. */
export interface AcpAgentRecordSource {
  read(): Promise<{
    readonly agents: readonly {
      readonly agentId: string;
      readonly enabled: boolean;
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }[];
  }>;
}

/** What the model factory and the session lifecycle need from the ACP host. */
export interface ExternalAgentTurnHost {
  driverFor(agentId: string): ExternalAgentTurnDriver;
  /** Releases the session's resident agent process. Safe to call repeatedly. */
  stopSession(sessionId: string): Promise<void>;
}

export interface AcpExternalAgentHostOptions {
  readonly records: AcpAgentRecordSource;
  readonly pool: AcpSessionPool;
}

export function createAcpExternalAgentHost(
  options: AcpExternalAgentHostOptions,
): ExternalAgentTurnHost {
  const drivers = new Map<string, ExternalAgentTurnDriver>();
  return {
    driverFor(agentId) {
      let driver = drivers.get(agentId);
      if (!driver) {
        driver = createAcpTurnDriver(agentId, options);
        drivers.set(agentId, driver);
      }
      return driver;
    },
    stopSession: (sessionId) => options.pool.stopSession(sessionId),
  };
}

function createAcpTurnDriver(
  agentId: string,
  options: AcpExternalAgentHostOptions,
): ExternalAgentTurnDriver {
  return {
    agentId,
    async runTurn(request) {
      const launch = await readEnabledLaunch(options.records, agentId);
      let runtime: AcpPoolRuntime;
      try {
        runtime = await options.pool.acquire(request.sessionId, {
          agentId,
          command: launch.command,
          args: launch.args,
          ...(launch.env === undefined ? {} : { env: launch.env }),
          cwd: request.workingDirectory,
        });
      } catch (error) {
        throw toStartFailure(error, agentId);
      }
      return runPrompt(runtime, agentId, request);
    },
  };
}

async function readEnabledLaunch(source: AcpAgentRecordSource, agentId: string) {
  const label = displayName(agentId);
  const snapshot = await source.read();
  const record = snapshot.agents.find((agent) => agent.agentId === agentId);
  if (!record) {
    throw new ExternalAgentTurnError(
      "agent_unavailable",
      `${label} is no longer configured. Enable it again in Settings > Model Providers.`,
    );
  }
  if (!record.enabled) {
    throw new ExternalAgentTurnError(
      "agent_unavailable",
      `${label} is turned off. Enable it in Settings > Model Providers to continue.`,
    );
  }
  return {
    command: record.command,
    args: [...record.args],
    ...(record.env === undefined ? {} : { env: { ...record.env } }),
  };
}

async function runPrompt(
  runtime: AcpPoolRuntime,
  agentId: string,
  request: ExternalAgentTurnRequest,
): Promise<ExternalAgentTurnResult> {
  let authRequired = false;
  const onEvent = (event: AcpRuntimeEvent) => {
    switch (event.type) {
      case "message_chunk":
        request.onEvent({ type: "message_delta", text: event.text });
        return;
      case "thought_chunk":
        request.onEvent({ type: "reasoning_delta", text: event.text });
        return;
      case "auth_required":
        authRequired = true;
        return;
      default:
        // Tool, plan, title and command updates belong to later slices; usage is read from the response.
        return;
    }
  };
  // Cancellation is a bounded session/cancel; the prompt then settles as `cancelled`.
  const onAbort = () => {
    void runtime.cancel().catch(() => undefined);
  };
  runtime.on("event", onEvent);
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await runtime.prompt("", toContentBlocks(request.prompt));
    const usage = toModelUsage(response.usage);
    return {
      agentId,
      stopReason: response.stopReason,
      ...(usage === undefined ? {} : { usage }),
    };
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw toPromptFailure(error, agentId, authRequired);
  } finally {
    runtime.off("event", onEvent);
    request.signal.removeEventListener("abort", onAbort);
  }
}

function toContentBlocks(prompt: readonly ExternalAgentPromptBlock[]): ContentBlock[] {
  return prompt.map((block): ContentBlock =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
}

/** ACP `usage` carries camelCase counters; only numeric fields are mapped. */
function toModelUsage(raw: unknown): ModelUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const count = (key: string): number | undefined =>
    typeof source[key] === "number" ? (source[key] as number) : undefined;
  const usage: Record<string, number> = {};
  const fields: [keyof ModelUsage, string][] = [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["totalTokens", "totalTokens"],
    ["reasoningTokens", "thoughtTokens"],
    ["cacheReadTokens", "cachedReadTokens"],
    ["cacheWriteTokens", "cachedWriteTokens"],
  ];
  for (const [target, key] of fields) {
    const value = count(key);
    if (value !== undefined) usage[target] = value;
  }
  return Object.keys(usage).length === 0 ? undefined : (usage as ModelUsage);
}

function toStartFailure(error: unknown, agentId: string): ExternalAgentTurnError {
  if (isAuthFailure(error)) return authRequiredError(agentId, error);
  return new ExternalAgentTurnError(
    "agent_unavailable",
    `${displayName(agentId)} could not be started. Check that it is installed and that its launch settings are correct.`,
    { cause: error },
  );
}

function toPromptFailure(
  error: unknown,
  agentId: string,
  authRequired: boolean,
): ExternalAgentTurnError {
  if (authRequired || isAuthFailure(error)) return authRequiredError(agentId, error);
  if (error instanceof AcpAgentDiedError) {
    return new ExternalAgentTurnError(
      "process_exited",
      `${displayName(agentId)} stopped during the turn. Send the message again to restart it.`,
      { cause: error },
    );
  }
  return new ExternalAgentTurnError(
    "prompt_failed",
    `${displayName(agentId)} could not complete the turn: ${messageOf(error)}`,
    { cause: error },
  );
}

function authRequiredError(agentId: string, cause: unknown): ExternalAgentTurnError {
  const definition = ACP_AGENT_DEFINITIONS.find((item) => item.agentId === agentId);
  const command = [definition?.binaries[0] ?? agentId, ...(definition?.loginArgs ?? [])].join(" ");
  return new ExternalAgentTurnError(
    "auth_required",
    `${displayName(agentId)} requires sign-in. Run "${command}" in a terminal, then send your message again.`,
    { cause },
  );
}

function isAuthFailure(error: unknown): boolean {
  return AUTH_FAILURE_PATTERN.test(messageOf(error));
}

function displayName(agentId: string): string {
  return ACP_AGENT_DEFINITIONS.find((item) => item.agentId === agentId)?.displayName ?? agentId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
