import { createWorkspaceMcpTrust } from "../workspace-mcp-trust/index.js";
import {
  zcodeWorkspaceMcpTrustParamsSchema,
  type ZCodeWorkspaceMcpTrustResult,
} from "@zcode/shared";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerStatus } from "@zcode/contracts";
import {
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  type ZCodeMcpListResult,
} from "@zcode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

export async function listMcpServers(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpListResult> {
  const params = parseParams(zcodeMcpListParamsSchema, rawParams);
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.zcode_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer,
    workingDirectory,
  });
  const explicitMcpServersProvided = params.mcpServers !== undefined;
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    // Desktop main resolves the local MCP list in Settings, including `.zcode` / `.agents` fallbacks;
    // the session runtime uses the same params.mcpServers. mcp/list cannot rely only on the agent's
    // createConfig, or `.agents` fallback entries will lack status snapshots and appear in red in the UI.
    ...(explicitMcpServersProvided
      ? (explicitRuntimeMcp?.servers ?? {})
      : configResult.config.mcp.servers),
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  const authority = createWorkspaceMcpTrust({
    workingDirectory,
    workspaceIdentity: params.workspace.workspaceIdentity,
    env: context.deps.env,
  });
  const reviews = await authority.inspect();
  const untrustedProjectMcpServers = new Set(
    Object.entries(reviews)
      .filter(([, review]) => !review.trusted)
      .map(([name]) => name),
  );
  for (const [name, config] of Object.entries(configuredMcpServers)) {
    if (!config.source && configResult.sources.mcp.serverSources[name] === "project") {
      configuredMcpServers[name] = { ...config, source: { kind: "workspace" } };
    } else if (!config.source && configResult.sources.mcp.serverSources[name] === "user") {
      configuredMcpServers[name] = { ...config, source: { kind: "user" } };
    }
  }
  const withReviews = async (statuses: Record<string, McpServerStatus>) => {
    for (const [name, review] of Object.entries(await authority.inspect())) {
      const config = configuredMcpServers[name];
      if (
        config?.source?.kind === "user" ||
        config?.source?.kind === "plugin" ||
        config?.source?.kind === "builtin"
      )
        continue;
      statuses[name] = {
        ...(statuses[name] ?? {
          status: "disconnected",
          transport: review.transport,
          toolCount: 0,
          updatedAt: new Date().toISOString(),
        }),
        ...(!review.configuredEnabled
          ? { status: "disabled" as const, toolCount: 0 }
          : !review.trusted
            ? { status: "untrusted" as const, toolCount: 0 }
            : {}),
        workspaceTrust: review,
      };
    }
    return statuses;
  };
  if (params.mode === "status") {
    // Read-only polling used to take over the shared lease and cancel other workspaces' OAuth; only an explicit connect may switch the owner.
    const cached = context.deps.mcpPort && settingsPorts.get(context.deps.mcpPort);
    const current = cached?.workspaceKey === params.workspace.workspaceKey ? cached : undefined;
    await current?.ready;
    let statuses = await listMcpServerStatuses(
      current && !current.controller.signal.aborted ? current.port : undefined,
      configuredMcpServers,
      untrustedProjectMcpServers,
    );
    // If an explicit switch happened during the read, drop the shared lease's late snapshot so it cannot leak into the new owner's state.
    if (current?.controller.signal.aborted) {
      statuses = await listMcpServerStatuses(
        undefined,
        configuredMcpServers,
        untrustedProjectMcpServers,
      );
    }
    return zcodeMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
  }

  const mcpPort = context.deps.mcpPort
    ? await settingsPort(context.deps.mcpPort, params.workspace.workspaceKey, authority)
    : undefined;
  if (mcpPort) {
    // OAuth polling is isolated by mode=status; default/connect must continue to reconcile with
    // replace semantics, or configuration additions/removals and stale MCP cleanup are skipped while
    // any server is awaiting authorization. Default/connect serves "probe again" requests such as a
    // Settings refresh. mcpPort is a process-level `protocol-settings` lease; without revalidate the
    // connection pool reuses old entries and returns stale snapshots, leaving stopped HTTP MCPs
    // shown as connected indefinitely (see adapters/src/mcp/pool.ts revalidateEntry).
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
        workspaceIdentity: params.workspace.workspaceIdentity,
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return zcodeMcpListResultSchema.parse({
        statuses: await withReviews(pendingAuthorizationSnapshot.statuses),
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
  );
  return zcodeMcpListResultSchema.parse({ statuses: await withReviews(statuses) });
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const settingsPorts = new WeakMap<
  McpPort,
  { workspaceKey: string; port: McpPort; controller: AbortController; ready: Promise<void> }
>();
async function settingsPort(
  raw: McpPort,
  workspaceKey: string,
  authority: ReturnType<typeof createWorkspaceMcpTrust>,
): Promise<McpPort> {
  const previous = settingsPorts.get(raw);
  if (previous?.workspaceKey === workspaceKey) {
    await previous.ready;
    return previous.port;
  }
  // Old OAuth can finish only after the switch; invalidate the old gate first so it cannot keep writing connections into the shared lease.
  previous?.controller.abort();
  const controller = new AbortController();
  const port = authority.guard(raw, controller.signal);
  // Cleanup serially waits only for the previous cleanup, not for OAuth; a concurrent switch must not late-disconnect the new workspace's connection.
  const ready = (previous?.ready ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      for (const name of Object.keys(await raw.status())) {
        if (controller.signal.aborted) return;
        await raw.disconnectServer(name);
      }
    });
  settingsPorts.set(raw, { workspaceKey, port, controller, ready });
  try {
    await ready;
  } catch (error) {
    // A failed cleanup must not cache a permanently rejected gate; abort only itself, never delete the new target that has taken over.
    controller.abort();
    if (settingsPorts.get(raw)?.port === port) settingsPorts.delete(raw);
    throw error;
  }
  return port;
}

export async function setWorkspaceMcpTrust(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkspaceMcpTrustResult> {
  const params = parseParams(zcodeWorkspaceMcpTrustParamsSchema, rawParams);
  try {
    await createWorkspaceMcpTrust({
      workingDirectory: params.workspace.workspacePath,
      workspaceIdentity: params.workspace.workspaceIdentity,
      env: context.deps.env,
    }).decide(params.serverName, params.declarationDigest, params.trusted);
    // Like Hooks, notify active sessions per workspace; a decision already persisted must not be misreported as an authorization failure.
    const refreshes = await Promise.allSettled(
      [...context.sessions.values()]
        .filter((record) => record.workspace.workspaceKey === params.workspace.workspaceKey)
        .map((record) => record.app.reloadWorkspaceMcpTrust?.()),
    );
    if (refreshes.some((result) => result.status === "rejected")) {
      context.logger?.warn("MCP trust admission refresh failed", {
        event: "mcp.trust.admission.refresh.failed",
        workspaceKey: params.workspace.workspaceKey,
      });
    }
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      reasonCode:
        error instanceof Error && error.message === "workspace_mcp_declaration_changed"
          ? "workspace_mcp_declaration_changed"
          : "workspace_mcp_trust_unavailable",
    };
  }
}
