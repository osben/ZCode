import type { LanguageServerPort, Logger, McpPort } from "@zcode/contracts";
import type { McpConnectionPool, McpTelemetryTracker } from "@zcode/adapters/mcp";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { shutdownPreparedModelTelemetry } from "@zcode/telemetry";
import { closeSessionStore } from "../app/session-store.js";
import type { NodeReplBrowserBroker } from "../app/node-repl-browser-broker.js";
import type { ZCodeProcessResourceSampler } from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

const DEFAULT_CLEANUP_BUDGET_MS = 1_200;
const CLEANUP_STEP_BUDGET_MS = 400;

export async function cleanupProtocolRuntime(options: {
  logger: Logger;
  deadlineAt?: number;
  server?: Pick<ZCodeProtocolAgentServer, "shutdown" | "disposeProjections">;
  processResourceSampler?: Pick<ZCodeProcessResourceSampler, "stop">;
  mcpTelemetryTracker?: Pick<McpTelemetryTracker, "stop">;
  nodeReplBrowserBroker?: Pick<NodeReplBrowserBroker, "close">;
  mcpPort?: Pick<McpPort, "close">;
  mcpConnectionPool?: Pick<McpConnectionPool, "close">;
  languageServerPort?: Pick<LanguageServerPort, "stopAll">;
  sessionStore?: SqliteSessionStore;
  providerRegistryRuntime?: { dispose(): unknown };
  /** Resident ACP agent processes of this worker (specs/acp-agent-runtime.md). */
  acpSessionPool?: { stopAll(): Promise<void> };
}): Promise<void> {
  const deadline = options.deadlineAt ?? Date.now() + DEFAULT_CLEANUP_BUDGET_MS;
  const step = async (resource: string, cleanup: () => unknown | Promise<unknown>) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Share one absolute deadline; a failed or hanging resource does not prevent attempts for the
      // others, and the deadline is not extended per resource.
      await Promise.race([
        Promise.resolve().then(cleanup),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Protocol cleanup timed out")),
            Math.max(0, Math.min(CLEANUP_STEP_BUDGET_MS, deadline - Date.now())),
          );
        }),
      ]);
    } catch (error) {
      options.logger.warn(`ZCode Protocol ${resource} shutdown failed`, {
        errorType: error instanceof Error ? error.name : typeof error,
        event: `zcode_protocol.${resource}.shutdown.failed`,
        module: "bootstrap.zcode_protocol",
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  await Promise.all([
    step("sampler", () => options.processResourceSampler?.stop()),
    step("mcp_telemetry", () => options.mcpTelemetryTracker?.stop()),
  ]);
  await step("sessions", () => options.server?.shutdown());
  await step("projections", () => options.server?.disposeProjections());
  await Promise.all([
    step("node_repl_browser_broker", () => options.nodeReplBrowserBroker?.close()),
    // Do not await inside the same finally block; the pool must still be closed if the port hangs.
    step("mcp", () => options.mcpPort?.close()),
    step("mcp_pool", () => options.mcpConnectionPool?.close()),
    step("lsp_pool", () => options.languageServerPort?.stopAll()),
  ]);
  await Promise.all([
    step("session_store", () => {
      if (options.sessionStore) closeSessionStore(options.sessionStore);
    }),
    step("acp_sessions", () => options.acpSessionPool?.stopAll()),
    step("provider_registry", () => options.providerRegistryRuntime?.dispose()),
    step("telemetry", () => shutdownPreparedModelTelemetry()),
  ]);
}
