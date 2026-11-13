import type { ZCodeProtocolError, ZCodeProtocolMessage, ZCodeProtocolResponse } from "@zcode/shared";
import {
  zcodePluginsCancelOperationParamsSchema,
  zcodePluginsReferenceCatalogParamsSchema,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
} from "@zcode/shared";
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
import type { createWorkflowRunReads } from "./workflow-run-reads.js";

type Handler = (params: unknown) => Promise<unknown> | unknown;

export interface ForkRustHelperServerDeps {
  context: ZCodeProtocolAgentServerContext;
  /** Opens the session store on first use (saved workflows and run history read the dwf journal). */
  ensureSessionStore(): Promise<void>;
  workflowRuns: ReturnType<typeof createWorkflowRunReads>;
}

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

/** Reason code of a session-authority plugin reference catalog request the helper cannot answer. */
export const FORK_RUST_HELPER_SESSION_CATALOG_UNAVAILABLE =
  "proto.forkRustAgent.sessionPluginCatalogUnavailable";

/**
 * Node answers a reference catalog with a `sessionId` from that session's frozen catalog and must not
 * fall back to workspace authority (plugin-reference-catalog.ts). The session lives in the Rust agent,
 * so the helper refuses that branch explicitly instead of reporting a missing session.
 */
function catalogForDraftsOnly(params: unknown): void {
  const parsed = parseParams(zcodePluginsReferenceCatalogParamsSchema, params);
  if (!parsed.sessionId) return;
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    "The Rust agent's Node helper has no session-owned plugin catalog",
    { reasonCode: FORK_RUST_HELPER_SESSION_CATALOG_UNAVAILABLE },
  );
}

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
      [zcodeProtocolMethods.pluginsReferenceCatalog]: (params) => {
        catalogForDraftsOnly(params);
        return getPluginReferenceCatalog(context, params);
      },
      [zcodeProtocolMethods.pluginsReferenceCatalogWithCategory]: (params) => {
        catalogForDraftsOnly(params);
        return getPluginReferenceCatalog(context, params, true);
      },
      [zcodeProtocolMethods.workflowsList]: (params) => listSavedWorkflowsOp(context, params),
      [zcodeProtocolMethods.workflowsGet]: (params) => getSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsUpdateMeta]: (params) => updateSavedWorkflowMetaOp(context, params),
      [zcodeProtocolMethods.workflowsDelete]: (params) => deleteSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsRuns]: (params) => listSavedWorkflowRunsOp(context, params),
      [zcodeProtocolMethods.workflowsMove]: (params) => moveSavedWorkflowOp(context, params),
      [zcodeProtocolMethods.workflowsSave]: (params) => saveSavedWorkflowFromRunOp(context, params),
      [zcodeProtocolMethods.workflowsForRun]: (params) => findSavedWorkflowForRunOp(context, params),
      ...deps.workflowRuns,
    };
    this.handlers = new Map(Object.entries(handlers));
  }

  /** Answers one inbound message; notifications and stray responses get no answer. */
  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolResponse | ZCodeProtocolError | undefined> {
    if (!("method" in message) || !("id" in message) || message.id === undefined) return undefined;
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
