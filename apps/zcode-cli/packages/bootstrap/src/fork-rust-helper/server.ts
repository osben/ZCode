import type { ZCodeProtocolError, ZCodeProtocolMessage, ZCodeProtocolResponse } from "@zcode/shared";
import { zcodePluginsCancelOperationParamsSchema, zcodeProtocolMethods } from "@zcode/shared";
import {
  callMcpUiTool,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  claimMcpUiAppToolCall,
  closeMcpUiInstance,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  openMcpUiInstance,
  readMcpUiResource,
  readMcpUiResourceForUi,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  sampleMcpUi,
  subscribeMcpUiResource,
  unregisterMcpUiAppTools,
  unsubscribeMcpUiResource,
  validateMcpUiInstance,
} from "../zcode-protocol/mcp-ui/index.js";
import { getPluginMentionItems } from "../zcode-protocol/plugin-mention-items.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "../zcode-protocol/plugin-reference-catalog.js";
import { listPluginUiSurfaces } from "../zcode-protocol/plugin-ui-surfaces.js";
import { readPluginUserOptions } from "../zcode-protocol/plugin-user-options.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "../zcode-protocol/plugins.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "../zcode-protocol/saved-workflows.js";
import {
  findSavedWorkflowForRunOp,
  saveSavedWorkflowFromRunOp,
} from "../zcode-protocol/saved-workflows-run.js";
import {
  getPluginOperationId,
  parseParams,
  PLUGIN_PREPARATION_MUTATION_METHODS,
  ProtocolRequestError,
  toProtocolError,
  type ZCodeProtocolAgentServerContext,
} from "../zcode-protocol/server-types.js";
import {
  FORK_RUST_HELPER_INITIALIZE,
  FORK_RUST_HELPER_METHODS,
  FORK_RUST_HELPER_PROTOCOL_VERSION,
} from "./methods.js";
import { FORK_RUST_HELPER_F3 } from "./f3-protocol.js";
import type { ForkRustHelperMcpHost } from "./mcp-host.js";
import type { ForkRustHelperClient } from "./rust-client.js";
import type { createWorkflowRunReads } from "./workflow-run-reads.js";

type Handler = (params: unknown) => Promise<unknown> | unknown;

export interface ForkRustHelperServerDeps {
  context: ZCodeProtocolAgentServerContext;
  /** Opens the session store on first use (saved workflows and run history read the dwf journal). */
  ensureSessionStore(): Promise<void>;
  workflowRuns: ReturnType<typeof createWorkflowRunReads>;
  /** F3: the helper's requests to the Rust agent (their answers arrive here). */
  client: ForkRustHelperClient;
  /** F3: Rust's MCP pipes and the helper sessions. */
  mcpHost: ForkRustHelperMcpHost;
}

/** F3 helper-protocol requests from Rust (specs/fork-rust-node-helper.md, "F3 Office tools and panels"). */
type HelperRequestHandler = (params: Record<string, unknown> | undefined) => Promise<unknown>;

/**
 * The saved-workflow methods that read the dwf journal (`listSavedWorkflowRunsOp`, and `runRecordOf`
 * behind save and forRun). The other five only touch workflow files, so, as in Node, they answer
 * without a database.
 */
const JOURNAL_BACKED_WORKFLOW_METHODS: ReadonlySet<string> = new Set([
  zcodeProtocolMethods.workflowsRuns,
  zcodeProtocolMethods.workflowsSave,
  zcodeProtocolMethods.workflowsForRun,
]);

/**
 * The helper's request dispatch: the F1+F2 handlers of Node's protocol server, unchanged, on a
 * sessionless context. Mirrors the parts of `ZCodeProtocolAgentServer` those handlers rely on: the
 * plugin operation abort map behind `plugins/cancelOperation`, and the plugin cache invalidation
 * after each plugin mutation.
 */
export class ForkRustHelperServer {
  private readonly operations = new Map<string, AbortController>();
  private readonly handlers: ReadonlyMap<string, Handler>;

  constructor(private readonly deps: ForkRustHelperServerDeps) {
    const context = deps.context;
    const withSignal =
      (run: (params: unknown, signal?: AbortSignal) => Promise<unknown>): Handler =>
      (params) =>
        this.withOperationSignal(params, (signal) => run(params, signal));
    const handlers: Record<(typeof FORK_RUST_HELPER_METHODS)[number], Handler> = {
      [zcodeProtocolMethods.pluginsList]: (params) => listPlugins(context, params),
      [zcodeProtocolMethods.pluginsOverview]: (params) => getPluginsOverview(context, params),
      [zcodeProtocolMethods.pluginsDescribe]: (params) => describePlugin(context, params),
      [zcodeProtocolMethods.pluginsInstall]: withSignal((params, signal) =>
        installPlugin(context, params, signal),
      ),
      [zcodeProtocolMethods.pluginsUninstall]: (params) => uninstallPlugin(context, params),
      [zcodeProtocolMethods.pluginsUpdate]: (params) => updatePlugin(context, params),
      [zcodeProtocolMethods.pluginsSetEnabled]: withSignal((params, signal) =>
        setPluginEnabled(context, params, signal),
      ),
      [zcodeProtocolMethods.pluginsConfigure]: (params) => configurePlugin(context, params),
      [zcodeProtocolMethods.pluginsResetConfig]: (params) => resetPluginConfig(context, params),
      [zcodeProtocolMethods.pluginsValidate]: (params) => validatePlugin(context, params),
      [zcodeProtocolMethods.pluginsRestoreBuiltin]: (params) => restoreBuiltinPlugin(context, params),
      [zcodeProtocolMethods.pluginsMarketplaceAdd]: withSignal((params, signal) =>
        addPluginMarketplace(context, params, signal),
      ),
      [zcodeProtocolMethods.pluginsMarketplaceRemove]: (params) =>
        removePluginMarketplace(context, params),
      [zcodeProtocolMethods.pluginsMarketplaceUpdate]: withSignal((params, signal) =>
        updatePluginMarketplace(context, params, signal),
      ),
      [zcodeProtocolMethods.pluginsResolveSuggestedReference]: withSignal((params, signal) =>
        resolveSuggestedPluginReference(context, params, signal),
      ),
      [zcodeProtocolMethods.pluginsCancelOperation]: (params) => this.cancelOperation(params),
      [zcodeProtocolMethods.pluginsReadUserOptions]: (params) => readPluginUserOptions(context, params),
      [zcodeProtocolMethods.pluginsListUiSurfaces]: (params) => listPluginUiSurfaces(context, params),
      // With a sessionId these answer from the frozen catalog of a session Rust opened (F3).
      [zcodeProtocolMethods.pluginsReferenceCatalog]: (params) =>
        getPluginReferenceCatalog(context, params),
      [zcodeProtocolMethods.pluginsReferenceCatalogWithCategory]: (params) =>
        getPluginReferenceCatalog(context, params, true),
      [zcodeProtocolMethods.workflowsList]: (params) => listSavedWorkflowsOp(context, params),
      [zcodeProtocolMethods.workflowsGet]: (params) => getSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsUpdateMeta]: (params) => updateSavedWorkflowMetaOp(context, params),
      [zcodeProtocolMethods.workflowsDelete]: (params) => deleteSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsRuns]: (params) => listSavedWorkflowRunsOp(context, params),
      [zcodeProtocolMethods.workflowsMove]: (params) => moveSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsSave]: (params) => saveSavedWorkflowFromRunOp(context, params),
      [zcodeProtocolMethods.workflowsForRun]: (params) => findSavedWorkflowForRunOp(context, params),
      ...deps.workflowRuns,
      // F3: the same handlers as Node's protocol server, on the helper's session records.
      [zcodeProtocolMethods.pluginsMentionItems]: (params) => getPluginMentionItems(context, params),
      [zcodeProtocolMethods.mcpReadResource]: (params) => readMcpUiResource(context, params),
      [zcodeProtocolMethods.mcpUiOpenInstance]: (params) => openMcpUiInstance(context, params),
      [zcodeProtocolMethods.mcpUiValidateInstance]: (params) => validateMcpUiInstance(context, params),
      [zcodeProtocolMethods.mcpUiCloseInstance]: (params) => closeMcpUiInstance(context, params),
      [zcodeProtocolMethods.mcpUiSampling]: (params) => sampleMcpUi(context, params),
      [zcodeProtocolMethods.mcpUiCancelSampling]: (params) => cancelMcpUiSampling(context, params),
      [zcodeProtocolMethods.mcpUiCallTool]: (params) => callMcpUiTool(context, params),
      [zcodeProtocolMethods.mcpUiCancelCall]: (params) => cancelMcpUiToolCall(context, params),
      [zcodeProtocolMethods.mcpUiReadResource]: (params) => readMcpUiResourceForUi(context, params),
      [zcodeProtocolMethods.mcpUiListResources]: (params) => listMcpUiResources(context, params),
      [zcodeProtocolMethods.mcpUiListResourceTemplates]: (params) =>
        listMcpUiResourceTemplates(context, params),
      [zcodeProtocolMethods.mcpUiSubscribeResource]: (params) => subscribeMcpUiResource(context, params),
      [zcodeProtocolMethods.mcpUiUnsubscribeResource]: (params) =>
        unsubscribeMcpUiResource(context, params),
      [zcodeProtocolMethods.mcpUiRegisterAppTools]: (params) => registerMcpUiAppTools(context, params),
      [zcodeProtocolMethods.mcpUiUnregisterAppTools]: (params) =>
        unregisterMcpUiAppTools(context, params),
      [zcodeProtocolMethods.mcpUiClaimAppToolCall]: (params) => claimMcpUiAppToolCall(context, params),
      [zcodeProtocolMethods.mcpUiResolveAppToolCall]: (params) =>
        resolveMcpUiAppToolCall(context, params),
    };
    this.handlers = new Map(Object.entries(handlers));
    const host = deps.mcpHost;
    this.helperRequests = new Map<string, HelperRequestHandler>([
      [FORK_RUST_HELPER_F3.mcpConnect, (params) => host.connect(params)],
      [FORK_RUST_HELPER_F3.sessionOpen, (params) => host.openSession(params)],
      [FORK_RUST_HELPER_F3.appToolsCall, (params) => host.callAppTool(params)],
      [FORK_RUST_HELPER_F3.ping, async () => ({})],
    ]);
    this.helperNotifications = new Map<string, HelperRequestHandler>([
      [FORK_RUST_HELPER_F3.mcpSend, (params) => host.send(params)],
      [
        FORK_RUST_HELPER_F3.mcpClose,
        (params) => host.closePipe(typeof params?.connection === "string" ? params.connection : ""),
      ],
      [FORK_RUST_HELPER_F3.sessionClose, (params) => host.closeSession(params)],
      [FORK_RUST_HELPER_F3.appToolsCancel, async (params) => host.cancelAppTool(params)],
    ]);
  }

  private readonly helperRequests: ReadonlyMap<string, HelperRequestHandler>;
  private readonly helperNotifications: ReadonlyMap<string, HelperRequestHandler>;

  /**
   * Answers one inbound message. A response settles one of the helper's own requests; a helper
   * notification runs its handler; other notifications get no answer.
   */
  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolResponse | ZCodeProtocolError | undefined> {
    if (!("method" in message)) {
      this.deps.client.handleResponse(message);
      return undefined;
    }
    if (!("id" in message) || message.id === undefined) {
      const run = this.helperNotifications.get(message.method);
      if (run) await run((message as { params?: Record<string, unknown> }).params);
      return undefined;
    }
    const { id, method, params } = message as { id: string | number; method: string; params?: unknown };
    try {
      return { id, result: await this.dispatch(method, params) };
    } catch (error) {
      return { id, error: toProtocolError(error) };
    }
  }

  /** Aborts every running plugin operation (stdin closed: the Rust agent is gone or reclaimed us). */
  abortAll(reason: Error): void {
    for (const controller of this.operations.values()) controller.abort(reason);
    this.operations.clear();
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === FORK_RUST_HELPER_INITIALIZE) return this.initialize(params);
    const helperRequest = this.helperRequests.get(method);
    if (helperRequest) return helperRequest(params as Record<string, unknown> | undefined);
    const handler = this.handlers.get(method);
    if (!handler) throw new ProtocolRequestError(-32601, `Method not found: ${method}`);
    if (JOURNAL_BACKED_WORKFLOW_METHODS.has(method)) await this.deps.ensureSessionStore();
    try {
      return await handler(params);
    } finally {
      // Same order as Node's server: a mutation invalidates only after it settled, so it does not
      // keep interrupting concurrent reads.
      if (PLUGIN_PREPARATION_MUTATION_METHODS.has(method)) {
        this.deps.context.deps.pluginPreparation?.invalidate();
        this.deps.context.deps.pluginDiscovery?.invalidate?.();
      }
    }
  }

  private initialize(params: unknown) {
    const version = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (version !== FORK_RUST_HELPER_PROTOCOL_VERSION) {
      throw new ProtocolRequestError(
        -32602,
        `Unsupported helper protocol version: ${String(version)} (expected ${FORK_RUST_HELPER_PROTOCOL_VERSION})`,
      );
    }
    return {
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
      methods: [...FORK_RUST_HELPER_METHODS],
    };
  }

  private async withOperationSignal<T>(
    params: unknown,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(params);
    if (!operationId) return await run();
    const controller = new AbortController();
    this.operations.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.operations.get(operationId) === controller) this.operations.delete(operationId);
    }
  }

  private cancelOperation(rawParams: unknown) {
    const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
    const controller = this.operations.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    controller.abort();
    this.operations.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }
}
