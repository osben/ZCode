import { join } from "node:path";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { ConfigResult } from "@zcode/adapters/config";
import {
  AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type ChildClientPortsContext,
  type PermissionService,
} from "@zcode/core";
import {
  type AgentExecutionTelemetryPort,
  type BrowserControlPort,
  type ContextSourcePort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type JsonSchema,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type ModelRequestAdmission,
  type SessionId,
  type SessionStorePort,
  type SkillPort,
  type SkillRoot,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowAgentCallInput,
  type WorkflowEscalatePort,
  type WorkflowSubmitPort,
} from "@zcode/contracts";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";
import type { ZCodeAppOptions } from "./types.js";

export interface ScriptWorkflowAgentRuntimeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: ZCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  fileSystemPort: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
/** Parent-session model factory: create Models for the child and main turn from the same Registry view instead of freezing separate copies. */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  /**
   * Plugin skill roots (the same `pluginOutcome.skillRoots` the main session's skill port uses).
   * Bundled skill roots are excluded: they contain only dynamic-workflows, and subagents must not
   * start workflows.
   */
  pluginSkillRoots: readonly SkillRoot[];
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  storageRoot: string;
  workingDirectory: string;
}

export function createScriptWorkflowAgentRuntime(input: {
  childSessionId: SessionId;
  deps: ScriptWorkflowAgentRuntimeDeps;
  request: WorkflowAgentCallInput;
  traceContext: TraceContext;
  /**
   * Configuration slice to override for the child runtime. DWF actors use it to set the tool
   * surface: `workflowActorToolPolicy` provides a `toolDisallowlist` (subtract from the full set),
   * while `request.opts.tools` can express only an allowlist. These are different degrees of freedom.
   */
  configOverrides?: Partial<AgentRuntimeConfig>;
  /**
   * Session-level submit port. Injecting it registers the submit_result tool for the session (core
   * gates registration on the port's presence); this is the terminal channel for DWF typed asks.
   */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * Typed `submit_result` declaration for mono subagents:
   * when present, core registers `{ result: <schema> }` instead of arbitrary JSON. Meaningful only when workflowSubmitPort is also present.
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * Session-level escalation port. Injecting it registers the `escalate` tool for the session
   * (core also gates registration on the port's presence); this is the actor's only help channel when genuinely blocked.
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * Model-request admission port. The driver provides it to DWF actors (each model-request attempt
   * passes through the process-level gate first). Subagents of the legacy `Workflow` tool omit it and
   * are not governed by or reported to the gate. It is passed through runtime deps alongside the two tool ports.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * `description` on interaction-request origins (the text of the permission window's source
   * badge). For DWF actors the factory supplies `<persona name> (<siteId>@<ordinal>)`
   * (workflow-actor-permission.ts); when absent, fall back to `request.opts.label` / agentType
   * (the existing behavior for legacy workflow children).
   */
  interactionDescription?: string;
  /**
   * The **parent session's** browser port (the one the main runtime uses). When present, the
   * subagent gets Browser Use: a child port is derived here via `forChildSession`—tabs belong to
   * the child session's own id, workspace / clientMode come from the parent session, and closing
   * the runtime closes the tabs and revokes registration. Passed only for DWF actors: their
   * runtime deterministically calls `closeBrowserSession` on run dispose; legacy workflow children
   * have no close chain, so it is omitted
   * (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Subagent sessions").
   */
  browserControlPort?: BrowserControlPort;
}): AgentRuntime {
  // DWF actors use the builder's overlay path via configOverrides.workflowActor, where systemPrompt
  // must be absent (the builder throws if both are set). The parent session's custom system prompt
  // must not leak to the subagent, so remove it from inherited config instead of relying on a later override.
  const { systemPrompt: inheritedSystemPrompt, ...inheritedConfig } = input.deps.runtimeConfig;
  const systemPrompt =
    input.configOverrides?.workflowActor === undefined
      ? (input.request.opts?.systemPrompt ?? inheritedSystemPrompt)
      : undefined;
  const parentSelection = input.deps.runtime.getSessionModelSelection();
  const requestedSelection = input.request.opts?.model
    ? parseProviderQualifiedModelSelection(input.request.opts.model)
    : undefined;
  if (input.request.opts?.model && !requestedSelection) {
    throw new Error(`Workflow child model must be provider-qualified: ${input.request.opts.model}`);
  }
  const modelSelection = requestedSelection ?? parentSelection;
  return new AgentRuntime(
    input.childSessionId,
    {
      ...inheritedConfig,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      agentName: input.request.opts?.agentType ?? "zcode-workflow",
      maxTurns: input.request.opts?.maxTurns ?? input.deps.runtimeConfig.maxTurns,
      // Baseline YOLO; the parent task keeps its own Guarded. Legacy script workflow children stop
      // here; DWF actors override via configOverrides with the mode recorded on the run
      // (docs/dynamic-workflow/launch.md, "Permissions inside a run").
      mode: "yolo",
      modelSelection,
      parentSessionId: input.deps.sessionId,
      subagents: { enabled: false },
      taskType: "workflow_child",
      // An actor exists only under a run, so it is naturally "already activated" (launch.md, "On
      // demand: activation", Children section): do not inherit the parent session's on-demand flag,
      // otherwise the spread would carry onDemand in while the child session has no activation entry point.
      dynamicWorkflowToolsOnDemand: false,
      toolAllowlist: input.request.opts?.tools,
      workingDirectory: input.deps.workingDirectory,
      ...input.configOverrides,
    },
    {
      ...createRuntimeDeps(input.deps, input.traceContext, input.childSessionId, {
        // External interaction ports must be created by the parent runtime; the client does not
        // recognize the child session as an identity.
        // This previously used `appOptions.providerRuntimeHeadersPort` /
        // `deps.permissionBroker` directly, so the actor asked Desktop with `sess_dwf-…`; Desktop's
        // `requireSession` threw, no response was sent, and the child agent hung before its first model request.
        agentId: input.childSessionId,
        agentType: input.request.opts?.agentType ?? "zcode-workflow",
        childSessionId: input.childSessionId,
        description:
          input.interactionDescription ??
          input.request.opts?.label ??
          input.request.opts?.agentType ??
          "workflow agent",
        ...(input.traceContext.turnId === undefined
          ? {}
          : { parentTurnId: input.traceContext.turnId }),
      }),
      ...(input.browserControlPort === undefined
        ? {}
        : {
            browserControlPort:
              input.browserControlPort.forChildSession?.({
                childSessionId: input.childSessionId,
                parentSessionId: input.deps.sessionId,
              }) ?? input.browserControlPort,
          }),
      ...(input.workflowSubmitPort ? { workflowSubmitPort: input.workflowSubmitPort } : {}),
      ...(input.workflowSubmitPort && input.workflowSubmitSchema
        ? { workflowSubmitSchema: input.workflowSubmitSchema }
        : {}),
      ...(input.workflowEscalatePort
        ? { workflowEscalatePort: input.workflowEscalatePort }
        : {}),
      ...(input.modelRequestAdmission
        ? { modelRequestAdmission: input.modelRequestAdmission }
        : {}),
    },
  );
}

function createRuntimeDeps(
  deps: ScriptWorkflowAgentRuntimeDeps,
  traceContext: TraceContext,
  childSessionId: SessionId,
  clientPortsContext: ChildClientPortsContext,
): ConstructorParameters<typeof AgentRuntime>[2] {
  return {
    agentTelemetry: deps.agentTelemetry,
    agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
    // A script workflow child has an independent lifecycle; use Link to retain its initiating relationship.
    agentTelemetryCausationMode: "linked_root",
    appVersion: deps.appVersion,
    artifactStore: deps.artifactStore,
    contextSourcePort:
      deps.contextSourcePort ??
      deps.appOptions.contextSourcePort ??
      createNodeContextSourceAdapter({ env: deps.appOptions.env }),
    // Live channel (same approach as subagents): raw child-session events only **notify** the
    // parent's external sink set. Preserve the child sessionId so the protocol can route it as a
    // detached live session; the parent no longer appends it, leaving exactly one copy of each event
    // in the shared store.
    //
    // Install this during **construction**: `ensureSessionPersistedForExternalActivity` writes
    // SessionTitleUpdated as sequenceNumber 1, while the v4 gateway drains only contiguous sequence
    // numbers. A subscription added after construction starts at seq 2 and waits forever for the
    // missing seq 1, which is why the old subscribeEvents channel never delivered live events.
    eventSink: {
      onSessionEvent: async (event) => {
        await deps.runtime.notifyExternalChildSessionEvent({
          childSessionId,
          event,
          traceContext,
          // Interaction events are also mirrored to the parent session: confirmation windows are
          // projected only from the parent session (the same ownership as createChildClientPorts;
          // docs/dynamic-workflow/launch.md, "Permissions inside a run").
          interactionOrigin: clientPortsContext,
        });
      },
    },
    // Share the event store with the parent runtime: child events are written to the same store under
    // the child's sessionId, so v4 `loadPersistedEvents(childSessionId)` finds them. A private
    // in-memory store would never be visible there, leaving the transcript permanently empty (as in
    // subagent.ts with `eventStore: this.eventStore`).
    eventStore: deps.runtime.getSessionEventStore(),
    executionPort:
      deps.appOptions.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: deps.appOptions.onToolExecResource,
        network: {
          httpProxy: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        },
        outputRootDir: join(deps.storageRoot, "cli", "exec"),
        processEnv: deps.appOptions.env ?? process.env,
      }),
    fileSystemPort: deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
    httpClientPort:
      deps.httpClientPort ??
      deps.appOptions.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: deps.appOptions.env ?? process.env,
        proxyUrl: deps.configResult.config.network.httpProxy,
        noProxy: deps.configResult.config.network.noProxy,
        caCertFile: deps.configResult.config.network.caCertFile,
        timeoutMs: deps.configResult.config.network.timeout,
      }),
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    logger: deps.logger,
    mcpPort: deps.mcpPort,
    modelFactory: deps.modelFactory,
    resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
    // This contains both permissionBroker and providerRuntimeHeadersPort: derive them from the parent runtime, with the routing identity rewritten to the parent session.
    ...deps.runtime.createChildClientPorts(clientPortsContext),
    permissionService: deps.permissionService,
    sessionStore: deps.sessionStore,
    skillPort: createWorkflowChildSkillPort(deps),
    traceContext,
  };
}

/**
 * Skill port for workflow children: user-configured roots + plugin skill roots, with disabled
 * paths matching the main session.
 *
 * Bug root cause (2026-09-30): this originally carried only the user-configured roots. Plugin
 * skill roots were later added to the main session's copy and this side drifted—DWF subagents
 * could not see browser-use's control-browser and had to dig through the plugin directory themselves.
 */
export function createWorkflowChildSkillPort(
  deps: Pick<ScriptWorkflowAgentRuntimeDeps, "appOptions" | "configResult" | "pluginSkillRoots">,
): SkillPort | undefined {
  if (!deps.configResult.config.features.skill || !deps.configResult.config.skills.enabled) {
    return undefined;
  }
  return (
    deps.appOptions.skillPort ??
    createNodeSkillAdapter({
      extraRoots: deps.configResult.config.skills.roots,
      extraResolvedRoots: [...deps.pluginSkillRoots],
      // The script workflow child runtime must not bypass a user-disabled SKILL.md path.
      disabledPaths: collectDisabledPaths(deps.configResult.config.skillOverrides),
    })
  );
}
