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
  type AcpPermissionAnswer,
  type AcpPermissionAsk,
  type AcpRuntimeEvent,
  type AcpToolCallInfo,
  type ContentBlock,
} from "@zcode/acp-agent-runtime";
import {
  ExternalAgentTurnError,
  type ExternalAgentPromptBlock,
  type ExternalAgentToolStatus,
  type ExternalAgentToolUpdate,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
  type Logger,
  type ModelUsage,
} from "@zcode/contracts";
import type { AcpPoolRuntime, AcpSessionPool } from "./acp-session-pool.js";
import {
  reconcileAcpSessionConfig,
  toExternalAgentConfig,
  type AcpAgentCatalogWriter,
  type AcpSessionConfigStore,
} from "./acp-config-reconcile.js";

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
  /** Worker logger for debug/warn facts that never reach the conversation (commands, stalls). */
  readonly logger?: Logger;
  /** Offered options and chosen values per session (S6). Without it no choice is re-applied. */
  readonly config?: AcpSessionConfigStore;
  /** Last offered options per agent (S6 readiness). Without it the composer has no catalog. */
  readonly catalog?: AcpAgentCatalogWriter;
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
      // Stop can arrive at any await of the spawn. The turn then ends cancelled and the agent gets no
      // prompt. A runtime that finished spawning stays resident for the next turn.
      const cancelled = (): ExternalAgentTurnResult => ({ agentId, stopReason: "cancelled" });
      const launch = await readEnabledLaunch(options.records, agentId);
      if (request.signal.aborted) return cancelled();
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
        if (request.signal.aborted) return cancelled();
        throw toStartFailure(error, agentId);
      }
      if (request.signal.aborted) return cancelled();
      // A session that could not be restored is shown to the user before the agent answers.
      if (runtime.takeSessionStart?.() === "reset") request.onEvent({ type: "context_reset" });
      // Chosen values reach the agent before the prompt; a change made during a running turn waits here.
      if (options.config !== undefined) {
        try {
          await reconcileAcpSessionConfig({
            runtime,
            store: options.config,
            sessionId: request.sessionId,
            agentId,
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
            onOptions: (configOptions) =>
              request.onEvent({ type: "config_options", options: configOptions }),
          });
        } catch (error) {
          if (request.signal.aborted) return cancelled();
          throw error;
        }
      }
      if (request.signal.aborted) return cancelled();
      // Asks of this agent session reach the turn only while the prompt runs (see pool.bindTurnPermission).
      const unbind = options.pool.bindTurnPermission(request.sessionId, (ask) =>
        toAcpPermissionAnswer(request, ask),
      );
      try {
        // The last check before session/prompt: a Stop that arrived while the permission bind ran is honoured.
        if (request.signal.aborted) return cancelled();
        return await runPrompt(runtime, agentId, request, options);
      } finally {
        unbind();
      }
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
  options: AcpExternalAgentHostOptions,
): Promise<ExternalAgentTurnResult> {
  const logger = options.logger;
  let authRequired = false;
  const onEvent = (event: AcpRuntimeEvent) => {
    switch (event.type) {
      case "message_chunk":
        request.onEvent({ type: "message_delta", text: event.text });
        return;
      case "thought_chunk":
        request.onEvent({ type: "reasoning_delta", text: event.text });
        return;
      case "tool_call":
        request.onEvent({ type: "tool_call", update: toToolUpdate(event.toolCall) });
        return;
      case "tool_call_update":
        request.onEvent({ type: "tool_call_update", update: toToolUpdate(event.toolCall) });
        return;
      case "plan":
        request.onEvent({
          type: "plan",
          entries: event.entries.map((entry) => ({
            content: entry.content,
            priority: entry.priority,
            status: entry.status,
          })),
        });
        return;
      case "session_title":
        request.onEvent({ type: "session_title", title: event.title });
        return;
      case "auth_required":
        authRequired = true;
        return;
      case "available_commands":
        logger?.debug("ACP agent advertised commands", {
          event: "external_agent.commands",
          module: "bootstrap.acp-agent",
          agentId,
          count: event.commands.length,
        });
        return;
      case "stalled":
        logger?.warn("ACP agent produced no output for a while", {
          event: "external_agent.stalled",
          module: "bootstrap.acp-agent",
          agentId,
          silentMs: event.silentMs,
        });
        request.onEvent({ type: "stalled", silentMs: event.silentMs });
        return;
      case "resumed":
        request.onEvent({ type: "resumed" });
        return;
      case "config_options": {
        // Agent-initiated change: the display copy shows the agent's value; choices stay as they are.
        const configOptions = toExternalAgentConfig(event.options);
        request.onEvent({ type: "config_options", options: configOptions });
        options.config?.writeOffered(request.sessionId, configOptions).catch((error: unknown) => {
          logger?.warn("ACP agent config options could not be stored", {
            event: "external_agent.config_store_failed",
            module: "bootstrap.acp-agent",
            agentId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      default:
        // Usage is read from the prompt response; exit and cleanup events are handled by the rejection path.
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

/** The turn's answer in ACP terms: only the kind of the user's choice is sent, never `allow_always`. */
async function toAcpPermissionAnswer(
  request: ExternalAgentTurnRequest,
  ask: AcpPermissionAsk,
): Promise<AcpPermissionAnswer> {
  const answer = await request
    .requestPermission({
      toolCallId: ask.toolCallId,
      title: ask.title,
      detail: ask.detail,
      optionKinds: ask.options.map((option) => option.kind),
    })
    .catch(() => "cancelled" as const);
  if (answer === "allow") return { outcome: "selected", kind: "allow_once" };
  if (answer === "deny") return { outcome: "selected", kind: "reject_once" };
  return { outcome: "cancelled" };
}

const TOOL_STATUSES: ReadonlySet<string> = new Set<ExternalAgentToolStatus>([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

/** ACP tool updates carry the raw update object; only the fields the turn contract needs are read. */
function toToolUpdate(info: AcpToolCallInfo): ExternalAgentToolUpdate {
  const raw = (info.raw ?? {}) as { rawInput?: unknown; content?: unknown };
  return {
    toolCallId: info.toolCallId,
    title: info.title.trim().length > 0 ? info.title : null,
    kind: info.kind ?? null,
    status:
      typeof info.status === "string" && TOOL_STATUSES.has(info.status)
        ? (info.status as ExternalAgentToolStatus)
        : null,
    input: raw.rawInput,
    output: textOfToolContent(raw.content),
  };
}

/** Text of an ACP tool content list: text blocks verbatim, diffs as their path and new text. */
function textOfToolContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const item of content as Record<string, unknown>[]) {
    if (item === null || typeof item !== "object") continue;
    if (item.type === "content") {
      const inner = item.content as { type?: unknown; text?: unknown } | undefined;
      if (inner?.type === "text" && typeof inner.text === "string") chunks.push(inner.text);
    } else if (item.type === "diff" && typeof item.path === "string") {
      const newText = typeof item.newText === "string" ? `\n${item.newText}` : "";
      chunks.push(`${item.path}${newText}`);
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n");
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
