import { isExternalAgentModel } from "@zcode/contracts";
/* eslint-disable max-lines -- Subagent runtime wiring centrally joins the child runtime, tool pool, permissions, MCP, and the activity watchdog; splitting it requires a dedicated migration. */
import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  SESSION_ENTRY_MODEL_SELECTION,
  parseModelSelectionValue,
} from "@zcode/contracts";
import type { SubagentRunOptions } from "@zcode/contracts";
import { inheritPermissionMode } from "@zcode/contracts";
import {
  defaultScheduler,
  PermissionService,
  defaultPermissionConfig,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  createExploreSubagentPort,
  createCoreError,
  CoreErrorType,
} from "../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  McpConnectionSnapshot,
  McpPort,
  Model,
  ModelSelection,
  SkillContent,
  SkillLoadOutcome,
  SkillOperationOptions,
  SkillPort,
  SubagentPort,
} from "../deps.js";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { resolveSubagentSelection } from "../helpers/subagent-selection.js";
import type { AgentRuntimeDeps } from "../types.js";
import { toMcpToolName } from "../../mcp/index.js";
import { createBorrowedSubagentMcpAccess } from "../../subagent/borrowed-mcp-port.js";
import { createSubagentMessageSink } from "../../subagent/message-steering.js";
import { latestAnnouncedEnvironment } from "./context-refresh.js";
import {
  extractRequiredMcpServerNames,
  matchesRequiredMcpServer,
} from "../../subagent/mcp-config.js";
import { mirrorSubagentToolEvent } from "../../subagent/tool-event-mirror.js";
import { isBuiltInExploreAgentProfile } from "../../subagent/profile.js";
import {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} from "../../subagent/tool-policy.js";
import { isSubagentDispatchToolName } from "../../tool/compat.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { getSessionShellEnvironment } from "./session-shell-environment.js";
import { deriveChildClientPorts } from "../helpers/child-client-ports.js";
import { createCoordinatorResponsePort } from "../../subagent/coordinator-response.js";
import { isStaleBranchRuntimeTaskEvent } from "./runtime-command-generation.js";
import { loadPersistentAgentMemory } from "../../subagent/persistent-memory.js";
import { filterSkillsByGrants, resolveSubagentSkillGrants } from "./subagent-skill-grants.js";
import {
  createOfficialCuaPolicy,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
  type OfficialCuaPolicy,
} from "../../subagent/computer-use-policy.js";
import { computeOfficialCuaServerNames } from "./mcp.js";
import { persistRuntimeModelSelection, sameModelSelection } from "./turn-model.js";
import { getOffPeakExecution, markTemporaryRuntimeSelection } from "../off-peak/runtime.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";

export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  if (this.config.subagents?.enabled === false) {
    return undefined;
  }

  const ownedRuntimes = new Set<AgentRuntime>();
  return createExploreSubagentPort({
    closeOwnedRuntimes: async () => {
      const results = await Promise.allSettled(
        [...ownedRuntimes].map(async (runtime) => {
          await runtime.close();
          ownedRuntimes.delete(runtime);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Subagent runtimes cleanup failed");
      ownedRuntimes.clear();
    },
    logger: this.logger,
    inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
    autoBackgroundMs: this.config.subagents?.autoBackgroundMs,
    outputRootDir: this.config.subagents?.outputRootDir,
    getAgentDefinitions: this.getAgentDefinitions,
    builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
    runtimeTaskRegistry: this.runtimeTaskRegistry,
    emitParentEvent: async (event, traceContext) => {
      if (isStaleBranchRuntimeTaskEvent(this, event)) return;
      await this.appendEvent(event, traceContext);
    },
    enqueueParentTaskNotification: (notification) => {
      this.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    getAllowedTools: () => {
      return buildExploreAllowedTools({
        embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(),
      });
    },
    runExploreAgent: async (request, options) => {
      const offPeak = getOffPeakExecution(this);
      const childBinding = offPeak?.createChildBinding();
      if (offPeak && !offPeak.lifecycle.terminal) {
        const selection = offPeak.lifecycle.ownedByUser
          ? this.getSessionModelSelection()
          : offPeak.selection;
        if (selection)
          options = {
            ...options,
            modelOverride: {
              selection,
              requestDependencies: childBinding?.requestDependencies,
              background: "allow",
            },
          };
      }
      try {
        request.reportActivity?.();
        const builtInExplore = isBuiltInExploreAgentProfile(request.profile);
        const agentsMdInstructions =
          request.profile.injectAgentsMd !== false
            ? this.contextSourceSnapshot?.userInstructions
            : undefined;
        const { selection: profileChildSelection, hasConcreteModel } = resolveSubagentSelection({
          profileSelection: request.profile.modelSelection,
          parentSelection: this.getSessionModelSelection(),
          overrideSelection: options?.modelOverride?.selection,
          resolveSelection: deps.resolveEffectiveModelSelection,
        });
        const modelOverride = options?.modelOverride;
        const inheritedModel = !modelOverride && !hasConcreteModel ? options?.model : undefined;
        // Core Server override takes precedence over the persisted profile and parent model inheritance, but is still a plain Selection.
        const childSelection = inheritedModel
          ? modelSelectionFromActiveModel(inheritedModel)
          : profileChildSelection;
        const embeddedSearchEnabled = resolveSubagentEmbeddedSearchEnabled();
        const baseChildEnvInfo = this.contextSourceSnapshot?.envInfo ??
          this.config.envInfo ?? {
            cwd: request.workingDirectory,
            platform: "unknown",
            shell: "unknown",
            osVersion: "unknown",
            nodeVersion: "unknown",
          };
        const shellEnvironment = getSessionShellEnvironment(this);
        const bashShellSelection = shellEnvironment?.selection;
        const childEnvInfo = {
          ...baseChildEnvInfo,
          ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
        };
        const baseAgentPrompt =
          builtInExplore && request.systemPrompt?.trim() === ""
            ? buildExploreAgentPrompt({ embeddedSearchEnabled })
            : request.systemPrompt?.trim();
        const persistentMemory = await loadPersistentAgentMemory({
          fileSystemPort: deps.fileSystemPort,
          logger: this.logger,
          memory: this.config.memory,
          profile: request.profile,
          traceContext: request.traceContext,
          workspaceRoot: request.workspaceRoot,
        });
        // An empty agent prompt is not a semantic segment; naively joining with `\n\n` first would
        // leak the missing segment's boundary into the start of persistent Memory. Compose only
        // non-empty bodies here; the builder adds the block's left boundary uniformly.
        const agentPrompt = [baseAgentPrompt, persistentMemory?.prompt]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const announcedEnvironment = latestAnnouncedEnvironment(
          this.messageHistory.borrowReadOnlyRuntimeEntries(),
        );
        const childRuntimeEnvInfo = {
          ...childEnvInfo,
          // After the parent switches directories, the startup snapshot's repository attributes are
          // stale; inherit only the latest accepted environment from the same cwd. Additional
          // directories belong to the parent's run configuration and are not inherited by the child,
          // so they must not seep into envInfo with the snapshot.
          ...(announcedEnvironment?.cwd === request.workingDirectory
            ? {
                platform: announcedEnvironment.platform,
                shell: announcedEnvironment.shell,
                osVersion: announcedEnvironment.osVersion,
                isGitRepository: announcedEnvironment.isGitRepository,
              }
            : {}),
          cwd: request.workingDirectory,
        };
        const officialCuaServerNames = computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        );
        const preflightCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          [],
          this.config.pluginReferenceCatalog,
        );
        // One discovery feeds both the CUA checks and the frozen skill grants (specs/subagent-skill-identity.md).
        const profileSkillDiscovery = await discoverProfileSkills.call(this, request);
        await validateSubagentComputerUseConfiguration(
          request,
          preflightCuaPolicy,
          profileSkillDiscovery,
        );
        const childMcpAccess = await resolveSubagentMcpAccess.call(
          this,
          request,
          officialCuaServerNames,
        );
        const childToolAllowlist = resolveSubagentToolAllowlist.call(
          this,
          request,
          childMcpAccess.snapshot?.tools.map((descriptor) => toMcpToolName(descriptor)) ?? [],
        );
        validateSubagentMcpRequirements(request, childToolAllowlist, childMcpAccess);
        const childMode = resolveSubagentPermissionMode(
          this.getPlanEnabled() ? "plan" : this.config.mode,
          request.permissionMode,
          builtInExplore,
        );
        const childCuaPolicy = createOfficialCuaPolicy(
          officialCuaServerNames,
          childMcpAccess.parentSnapshot?.tools ?? childMcpAccess.snapshot?.tools ?? [],
          this.config.pluginReferenceCatalog,
        );
        await validateSubagentComputerUseConfiguration(
          request,
          childCuaPolicy,
          profileSkillDiscovery,
        );
        const childSkillPort = await resolveSubagentSkillPort.call(
          this,
          request,
          profileSkillDiscovery,
          childCuaPolicy,
        );
        const baseChildModelFactory = modelOverride
          ? createSubagentOverrideModelFactory(modelOverride, this.modelFactory)
          : inheritedModel
            ? createInheritedSubagentModelFactory(childSelection, inheritedModel, this.modelFactory)
            : this.modelFactory;
        if (!baseChildModelFactory) {
          throw createCoreError(
            CoreErrorType.ConfigurationError,
            `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
            { recoverable: true },
          );
        }
        // External-agent (ACP) models run only foreground chat turns. An inherited selection can
        // carry the parent's ACP model into a child, so every child model is checked here.
        const requireSubagentModel: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) => {
          const model = baseChildModelFactory(target);
          if (isExternalAgentModel(model)) {
            throw createCoreError(
              CoreErrorType.ConfigurationError,
              `Subagents cannot run the external agent model ${String(model.providerId)}/${String(model.modelId)}; choose a ZCode model for this subagent.`,
              { recoverable: true },
            );
          }
          return model;
        };
        const childModel = requireSubagentModel({ selection: childSelection });
        const childModelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) =>
          target.selection.providerId === childSelection.providerId &&
          target.selection.modelId === childSelection.modelId &&
          target.selection.options?.reasoningLevel === childSelection.options?.reasoningLevel
            ? childModel
            : requireSubagentModel(target);
        const parentToolCallId = traceStringAttribute(request.traceContext, "parentToolCallId");
        // Outbound interaction ports (permission broker + provider runtime headers): shared
        // derivation with dwf actors and legacy workflow children; routing identity uniformly
        // resolves to this runtime's session.
        const childClientPorts = deriveChildClientPorts(
          {
            permissionBroker: this.permissionBroker,
            ...(this.providerRuntimeHeadersPort === undefined
              ? {}
              : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
          },
          {
            agentId: request.agentId,
            agentType: request.agentType,
            childSessionId: request.sessionId,
            description: request.description,
            parentSessionId: this.sessionId,
            parentToolCallId,
            ...(request.traceContext.turnId === undefined
              ? {}
              : { parentTurnId: request.traceContext.turnId }),
          },
        );
        // Browser Use: the subagent shares tabs with the current conversation (tabOwner: "parent") —
        // the user sees its tabs in the panel and it sees the conversation's existing tabs; workspace /
        // clientMode are registered back to the parent session via forChildSession. When the subagent
        // ends, only the registration is revoked, not the tabs. Without forChildSession on the port
        // (CLI headless), fall back to the child session's own scope.
        const childBrowserControlPort =
          this.browserControlPort?.forChildSession?.({
            childSessionId: request.sessionId,
            parentSessionId: this.sessionId,
            tabOwner: "parent",
          }) ?? this.browserControlPort;
        const mirroredToolNameByChildToolCallId = new Map<string, string>();
        let sessionReadyNotified = false;
        const notifySessionReady = async () => {
          if (sessionReadyNotified) return;
          await request.onSessionReady?.();
          sessionReadyNotified = true;
        };
        this.logger?.debug("Starting subagent child runtime", {
          parentSessionId: this.sessionId,
          childSessionId: request.sessionId,
          agentType: request.agentType,
        });
        const childRuntime = new AgentRuntime(
          request.sessionId,
          {
            // The old plan enum lacks base permissions; after the split, inherit the full state so the constructor does not fall back to build.
            mode: childMode === "plan" ? this.config.mode : childMode,
            planEnabled: childMode === "plan",
            // Model selection affects more than the final request.model: MCS, built-in search, and
            // token/media budgets are pre-shaped inside the child runtime by the default model. A
            // synchronous child must therefore point its whole execution config at the parent-turn
            // snapshot; the runner forbids it from going to background, and the parent turn's finally
            // cleans up the provider registry, so the snapshot can never become a resumable session
            // config.
            modelSelection: cloneModelSelection(childSelection),
            modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
            workingDirectory: request.workingDirectory,
            // The child runs in the same (possibly linked-worktree) cwd as the parent; carrying the
            // fact lets the subagent env block render the same isolation notice as the main agent.
            executionWorktree: this.config.executionWorktree,
            incognito: this.config.incognito,
            // The execution model is projected into Context only by the child Active Model; envInfo keeps no second copy of model facts.
            envInfo: childRuntimeEnvInfo,
            // Explore child runtimes previously did not inherit the main session's streaming config,
            // so even with modelStreaming on by default on the Protocol desktop, child requests fell
            // back to generateText. Some OpenAI-compatible endpoints return SSE `data:` frames even
            // for non-streaming requests, and generateText parses them as plain JSON and fails with
            // Invalid JSON response; inheriting the parent config lets the child agent use the same
            // streamText semantics as the main chain.
            modelStreaming: this.config.modelStreaming,
            bashTimeoutPolicy: this.config.bashTimeoutPolicy,
            midConversationSystem: this.config.midConversationSystem,
            toolSearch: this.config.toolSearch,
            bashShellSelection,
            // The child only reuses the parent runtime's already-resolved instructions snapshot; Project Context is still not inherited.
            currentDate: this.contextSourceSnapshot?.currentDate ?? this.config.currentDate,
            subagentContext: {
              agentPrompt: agentPrompt ?? "",
              ...(agentsMdInstructions ? { userInstructions: agentsMdInstructions } : {}),
            },
            agentName: `zcode-${request.agentType}`,
            maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns ?? 4,
            parentSessionId: this.sessionId,
            taskType: "subagent_child",
            // The dynamic-workflow rollout gate must be inherited structurally: parent off while a
            // subagent is on would make the Agent tool a backdoor around the rollout. The default
            // path (child inheriting the tool names visible in the parent registry) already covers
            // it, but a custom agent profile that explicitly writes `allowedTools: ["CreateWorkflow"]`
            // skips that intersection — this flag is the only remaining barrier.
            dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
            // launch.md "On demand: activation", Children: a subagent inherits the parent session's
            // tool surface **as of now** — if the parent has not activated, the child is also
            // on-demand (the child session has no `/workflow` entry, so effectively no workflow
            // tools); if the parent has activated, the child is registered at birth.
            dynamicWorkflowToolsOnDemand:
              this.config.dynamicWorkflowToolsOnDemand === true &&
              !this.dynamicWorkflowToolsActivated,
            // Fix reason: the default subagent changed from Explore to general-purpose. The toolset
            // can no longer depend on DEFAULT_SUBAGENT_TYPE, or the default general-purpose agent
            // gets wrongly demoted to the read-only search tool surface.
            toolset: builtInExplore ? "explore" : "main",
            toolAllowlist: childToolAllowlist,
            toolDisallowlist: this.config.toolDisallowlist,
            embeddedSearchBackend: this.config.embeddedSearchBackend,
            nativeSearchEnhancementsEnabled: this.config.nativeSearchEnhancementsEnabled,
            subagents: {
              backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
              enabled: false,
            },
            mcp: childMcpAccess.config,
          },
          {
            agentTelemetry: this.agentTelemetry.port,
            agentTelemetryCausation: this.agentTelemetry.captureCausation(),
            // A foreground child's lifetime is awaited by the parent Agent Tool, so it uses a real
            // parent-child Span; a background child may outlive the parent Tool/Turn and can only
            // keep causality as an independent Trace with a Link.
            agentTelemetryCausationMode: request.background ? "linked_root" : "child",
            eventStore: this.eventStore,
            // Date announcements read the runtime clock; the child inherits the parent clock, so parent and child share one date source.
            now: this.now,
            sessionStore: deps.sessionStore,
            // Shared host-environment read port, used only for environment detection after a cd inside the child; the initial snapshot and instructions both come from the parent's config.
            contextSourcePort: this.contextSourcePort,
            // Child runtime model-request admission: use the subagent factory when the assembler
            // provides one (gated; subagents of the same parent session share one queue); otherwise
            // keep the parent's port.
            // Fix reason: subagents used to inherit the parent's observer directly (no queueing, no
            // Retry-After), and several parallel Agent calls in one turn amplified into a 1302 storm
            // (docs/dynamic-workflow/concurrency.md "Where the port is bound").
            modelRequestAdmission:
              deps.subagentModelRequestAdmission?.(this.sessionId) ?? this.modelRequestAdmission,
            modelFactory: childModelFactory,
            resolveEffectiveModelSelection: deps.resolveEffectiveModelSelection,
            // The child runtime still persists events and archives traces under request.sessionId;
            // every blocking outbound interaction (permission / AskUserQuestion / provider runtime
            // headers) routes back to the parent session — the desktop UI only knows the parent
            // task's sessionId. The derivation is centralized in deriveChildClientPorts, shared by
            // dwf actors and legacy workflow children.
            ...childClientPorts,
            ...(childBrowserControlPort === undefined
              ? {}
              : { browserControlPort: childBrowserControlPort }),
            coordinatorResponsePort: createCoordinatorResponsePort({
              agentId: request.agentId,
              agentType: request.agentType,
              childSessionId: request.sessionId,
              parentToolCallId,
              enqueue: (input) => this.enqueueSubagentMessage(input),
            }),
            // Explore uses its own read-only permission config; general-purpose and custom agents inherit the parent permission service.
            permissionService: builtInExplore
              ? new PermissionService(defaultPermissionConfig)
              : this.permissionService,
            toolScheduler: deps.toolScheduler ?? defaultScheduler,
            executionPort: deps.executionPort,
            fileSystemPort: deps.fileSystemPort,
            // Explore child runtimes expose WebFetch but previously did not inherit the main
            // runtime's HTTP client port, so the tool threw a config error before any real request
            // instead of failing as a network request.
            httpClientPort: deps.httpClientPort,
            imageProcessorPort: deps.imageProcessorPort,
            pdfDocumentPort: deps.pdfDocumentPort,
            memoryRoot: persistentMemory?.rootDir,
            mcpPort: childMcpAccess.port,
            skillPort: childSkillPort,
            artifactStore: deps.artifactStore,
            appVersion: this.appVersion,
            eventSink: {
              onSessionEvent: async (event) => {
                request.reportActivity?.();
                // Child runtime events are already persisted under childSessionId, but the old chain
                // mirrored only a few tool events to the parent sink, so a UI subscribed to the child
                // topic got only the initial hydration and no streamed updates. The raw child event
                // only notifies the parent runtime's external sinks without appending again, so it is
                // not double-persisted; bootstrap then routes it to the child publisher by
                // event.sessionId.
                await this.notifyEventSinks(event, {
                  ...request.traceContext,
                  sessionId: request.sessionId,
                });
                const mirroredEvent = mirrorSubagentToolEvent(event, {
                  agentId: request.agentId,
                  agentType: request.agentType,
                  background: request.background,
                  childSessionId: request.sessionId,
                  description: request.description,
                  parentSessionId: this.sessionId,
                  parentToolCallId,
                  parentTurnId: request.traceContext.turnId,
                  toolNameByChildToolCallId: mirroredToolNameByChildToolCallId,
                });
                if (!mirroredEvent) return;

                // The parent mirror keeps its original semantics: the parent session sees only
                // subagent summaries/tool activity; raw child bodies never pollute the parent timeline.
                await this.notifyEventSinks(mirroredEvent, {
                  ...request.traceContext,
                  sessionId: this.sessionId,
                });
              },
            },
            logger: this.logger,
            traceContext: request.traceContext,
          },
        );

        // A finished child may still own background Bash, title/MCP work; the parent session close must still be able to find it.
        ownedRuntimes.add(childRuntime);
        try {
          const resumesExistingChild = request.resumeFromStore === true;
          if (childBinding)
            markTemporaryRuntimeSelection(
              childRuntime as unknown as AgentRuntimeInternal,
              offPeak?.ordinarySelection,
            );
          let previousSelection: ModelSelection | undefined;
          if (resumesExistingChild) {
            const persistedMessages = await this.sessionStore?.messages({
              sessionID: request.sessionId,
            });
            // Terminal resume only restores existing history; a failure before model initialization must not become an empty session creation.
            if (!persistedMessages?.length) {
              throw createCoreError(
                CoreErrorType.SessionNotFound,
                `No transcript found for agent ${request.agentId}`,
                { recoverable: true },
              );
            }
            const entries = await this.sessionStore?.sessionEntries?.({
              sessionID: request.sessionId,
              type: SESSION_ENTRY_MODEL_SELECTION,
            });
            previousSelection = parseModelSelectionValue(entries?.at(-1)?.data);
            await childRuntime.resumeFromStore({
              persistedMessages,
              traceContext: request.traceContext,
            });
            // Resume only imports history; this run's profile-selected model stays the execution authority and updates the selection record used by cold resume.
            await persistRuntimeModelSelection(
              childRuntime as unknown as AgentRuntimeInternal,
              childSelection,
            );
          } else {
            // The parent used to publish SubagentSpawned first and only the child's first
            // executeTurn persisted it. Under concurrent spawns, a directory query between the two
            // read one child short. Persistence is now promoted to a pre-publish gate.
            await childRuntime.ensureSessionPersistedForExternalActivity(request.prompt, {
              traceContext: request.traceContext,
            });
          }
          await notifySessionReady();
          if (
            !resumesExistingChild ||
            (previousSelection && !sameModelSelection(previousSelection, childSelection))
          ) {
            // Resuming the same model does not insert a duplicate divider; a config change reuses the existing event and transcript record.
            childRuntime.recordPendingModelChange({
              ...(previousSelection
                ? {
                    fromModel: previousSelection,
                    fromModelLabel: `${previousSelection.providerId}/${previousSelection.modelId}`,
                  }
                : {}),
              toModel: childSelection,
              toModelLabel: `${childSelection.providerId}/${childSelection.modelId}`,
            });
            await childRuntime.emitModelSelected({
              modelSelection: childSelection,
              effectiveReasoningLevel: childModel.options.reasoningLevel,
              previousModelSelection: previousSelection ?? null,
              traceContext: request.traceContext,
            });
          }
          request.registerMessageSink?.(createSubagentMessageSink(childRuntime, request));
          return await childRuntime.executeTurn(request.prompt, undefined, {
            ...(childBinding
              ? {
                  offPeakTaskId: offPeak!.offPeakTaskId,
                  modelExecution: {
                    selectionScope: "execution" as const,
                    memoryExtraction: "skip" as const,
                  },
                }
              : { offPeakTaskId: undefined }),
            abortSignal: options?.signal,
            // The child runtime's first input comes from the parent Agent, not a real user; keep the
            // source fact so Subagent Turns are not misclassified as user in traces and success-rate
            // reports.
            inputSource: "subagent",
            inputPresentation: "coordinator_input",
            traceContext: request.traceContext,
          });
        } finally {
          const cancelled = options?.signal?.aborted === true;
          childRuntime.sealBackgroundTaskNotifications({
            reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
            traceContext: request.traceContext,
          });
          // Execution outcome and resource release are separate; on failure the handle is kept, and the final owner close judges by the release result at that time.
          const released = cancelled ? childRuntime.close() : childRuntime.retire();
          const release = released.then(
            () => {
              ownedRuntimes.delete(childRuntime);
            },
            (error: unknown) =>
              this.logger?.warn("Subagent resource cleanup pending", {
                event: "subagent.cleanup.pending",
                childSessionId: request.sessionId,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
          if (cancelled || !childRuntime.hasResidencyBlockingWork()) await release;
        }
      } finally {
        childBinding?.release();
      }
    },
  });
}

function resolveSubagentEmbeddedSearchEnabled(): boolean {
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: true,
  });

  return embeddedSearchDecision.useEmbeddedSearchBranch;
}

export function createInheritedSubagentModelFactory(
  inheritedSelection: ModelSelection,
  inheritedModel: Model,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): NonNullable<AgentRuntimeDeps["modelFactory"]> {
  return (target) => {
    if (
      target.selection.providerId === inheritedSelection.providerId &&
      target.selection.modelId === inheritedSelection.modelId &&
      target.selection.options?.reasoningLevel === inheritedSelection.options?.reasoningLevel
    ) {
      // Selection keeps its sparse explicit-intent form; it must not be compared against the Active
      // Model's full effective options, or default values would inevitably fail the reuse check and
      // force the child to reinterpret a mutable Registry.
      return inheritedModel;
    }
    return fallbackFactory(target);
  };
}

export function modelSelectionFromActiveModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function createSubagentOverrideModelFactory(
  override: NonNullable<SubagentRunOptions["modelOverride"]>,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): AgentRuntimeDeps["modelFactory"] {
  return (target) => {
    const model = fallbackFactory({
      ...target,
      selection: override.selection,
      requestDependencies: override.requestDependencies,
    });
    return getOffPeakModelBinding(override.requestDependencies)?.wrap(model) ?? model;
  };
}

function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  builtInExplore: boolean,
): AgentRuntimeInternal["config"]["mode"] {
  switch (permissionMode) {
    case "bypassPermissions":
    case "dontAsk":
      return inheritPermissionMode(parentMode, "yolo");
    case "acceptEdits":
      return "edit";
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "default":
    case undefined:
      return inheritPermissionMode(parentMode, builtInExplore ? "yolo" : parentMode);
    default:
      return parentMode;
  }
}

function resolveSubagentToolAllowlist(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  visibleMcpToolNames: readonly string[],
): readonly string[] {
  const disallowedRules = buildSubagentChildDisallowRules([
    ...(this.config.toolDisallowlist ?? []),
    ...(request.disallowedTools ?? []),
  ]);
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) {
    const parentAllowedMcpToolNames = filterMcpToolNamesByParentAllowlist(
      visibleMcpToolNames,
      this.config.toolAllowlist,
    );
    const availableToolNames = [
      ...this.getTools()
        // Child MCP must use the same descriptor batch as the parent startup snapshot;
        // it must not be re-derived from another registry view.
        .filter((tool) => tool.permission?.permission !== "mcp")
        .map((tool) => tool.name),
      ...parentAllowedMcpToolNames,
    ];
    return appendCoordinatorResponseTool(
      [...new Set(availableToolNames)]
        .filter((toolName) => !isSubagentDispatchToolName(toolName))
        .filter((toolName) => filterSubagentChildToolNames([toolName], disallowedRules).length > 0),
    );
  }
  if (request.allowedTools.length > 0) {
    return appendCoordinatorResponseTool(
      filterSubagentChildToolNames(request.allowedTools, disallowedRules),
    );
  }
  return appendCoordinatorResponseTool([]);
}

function filterMcpToolNamesByParentAllowlist(
  toolNames: readonly string[],
  parentAllowlist: readonly string[] | undefined,
): readonly string[] {
  if (parentAllowlist === undefined) return toolNames;
  const allowed = new Set(parentAllowlist);
  return toolNames.filter((toolName) => allowed.has(toolName));
}

function isModelVisibleMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function appendCoordinatorResponseTool(toolNames: readonly string[]): readonly string[] {
  if (toolNames.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
    return toolNames;
  }

  // The child control channel is not constrained by the profile's tool list; the global toolDisallowlist still applies at the runtime registration boundary.
  return [...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME];
}

interface ResolvedSubagentMcpAccess {
  config: { enabled?: boolean } | undefined;
  port: McpPort | undefined;
  parentSnapshot: McpConnectionSnapshot | undefined;
  snapshot: McpConnectionSnapshot | undefined;
}

async function resolveSubagentMcpAccess(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  officialCuaServerNames: ReadonlySet<string>,
): Promise<ResolvedSubagentMcpAccess> {
  if (!shouldBorrowParentMcp(request)) {
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const scopedServerNames = request.profile.mcpServers?.length
    ? request.profile.mcpServers
    : undefined;
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: this.config.mcp?.enabled === false ? { enabled: false } : undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  // The child does not own the connection lifecycle; it can only reuse the startup snapshot the parent constructor already created.
  const parentStartupSnapshot = await this.mcpStartupPromise;
  if (!parentStartupSnapshot) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const unavailableScopedServerNames = (scopedServerNames ?? []).filter(
    (serverName) => parentStartupSnapshot.statuses[serverName]?.status !== "connected",
  );
  if (unavailableScopedServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableScopedServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableScopedServerNames,
        },
        recoverable: true,
      },
    );
  }

  const borrowed = createBorrowedSubagentMcpAccess(
    this.mcpPort,
    parentStartupSnapshot,
    scopedServerNames,
    officialCuaServerNames,
  );
  return {
    config: { enabled: true },
    parentSnapshot: parentStartupSnapshot,
    port: borrowed.port,
    snapshot: borrowed.snapshot,
  };
}

function shouldBorrowParentMcp(request: ExploreSubagentRuntimeRequest): boolean {
  if ((request.profile.mcpServers?.length ?? 0) > 0) return true;
  if (request.allowedTools.length === 0 || request.allowedTools.includes("*")) return true;
  return request.allowedTools.some((toolName) => {
    const normalized = toolName.trim();
    return isConcreteMcpToolName(normalized) || isMcpServerSelector(normalized);
  });
}

function validateSubagentMcpRequirements(
  request: ExploreSubagentRuntimeRequest,
  effectiveAllowedTools: readonly string[],
  access: ResolvedSubagentMcpAccess,
): void {
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) return;

  const normalizedAllowedTools = effectiveAllowedTools.map((toolName) => toolName.trim());
  const requiredToolNames = normalizedAllowedTools.filter(isConcreteMcpToolName);
  const requiredServerNames = extractRequiredMcpServerNames(
    normalizedAllowedTools.filter(isMcpServerSelector),
  );
  if (requiredToolNames.length === 0 && requiredServerNames.length === 0) return;
  if (!access.port || !access.snapshot) {
    throw createSubagentMcpUnavailableError(request, requiredToolNames);
  }
  const snapshot = access.snapshot;

  const unavailableServerNames = requiredServerNames.filter(
    (serverName) => !matchesRequiredMcpServer(serverName, snapshot.statuses),
  );
  if (unavailableServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableServerNames,
        },
        recoverable: true,
      },
    );
  }

  const visibleToolNames = new Set(snapshot.tools.map((descriptor) => toMcpToolName(descriptor)));
  const missingToolNames = requiredToolNames.filter((toolName) => !visibleToolNames.has(toolName));
  if (missingToolNames.length === 0) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Required MCP tool is not available in the parent startup snapshot: ${missingToolNames.join(", ")}`,
    {
      context: {
        agentType: request.agentType,
        missingMcpTools: missingToolNames,
      },
      recoverable: true,
    },
  );
}

function isConcreteMcpToolName(toolName: string): boolean {
  return isModelVisibleMcpToolName(toolName) && !isMcpServerSelector(toolName);
}

function isMcpServerSelector(toolName: string): boolean {
  return toolName === "mcp" || (toolName.startsWith("mcp__") && toolName.endsWith("__*"));
}

function createSubagentMcpUnavailableError(
  request: ExploreSubagentRuntimeRequest,
  requiredToolNames: readonly string[] = [],
) {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Subagent MCP is unavailable because the parent startup snapshot is unavailable",
    {
      context: {
        agentType: request.agentType,
        requiredMcpTools: requiredToolNames,
      },
      recoverable: true,
    },
  );
}

/**
 * Discovery result shared by the CUA checks and the frozen skill grants for one child start.
 * `skipped` means the profile declares no skills (or there is no skill port); `failed` fails closed.
 */
type ProfileSkillDiscovery =
  | { readonly status: "skipped" }
  | { readonly status: "failed" }
  | { readonly status: "ok"; readonly outcome: SkillLoadOutcome };

async function discoverProfileSkills(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
): Promise<ProfileSkillDiscovery> {
  if (!this.skillPort || !request.profile.skills?.length) return { status: "skipped" };
  try {
    // Same request shape as the child's own listing (discoverSkillsForContext), so grants are
    // resolved against the roots the child will list from.
    const outcome = await this.skillPort.discoverSkills({
      workingDirectory: request.workingDirectory,
      trace: request.traceContext,
    });
    return { status: "ok", outcome };
  } catch (error) {
    this.logger?.warn("Subagent skill discovery failed; starting without granted skills", {
      agentType: request.agentType,
      error: error instanceof Error ? error.message : String(error),
      event: "subagent.skill_grants.discovery_failed",
    });
    return { status: "failed" };
  }
}

async function resolveSubagentSkillPort(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  discovery: ProfileSkillDiscovery,
  cuaPolicy: OfficialCuaPolicy,
): Promise<SkillPort | undefined> {
  if (!this.skillPort) {
    return this.skillPort;
  }
  const entries = request.profile.skills ?? [];
  if (discovery.status === "skipped") {
    return new FilteredSkillPort(this.skillPort, undefined, entries, cuaPolicy);
  }
  if (discovery.status === "failed") {
    return new FilteredSkillPort(this.skillPort, new Set(), entries, cuaPolicy);
  }
  const grants = resolveSubagentSkillGrants(entries, discovery.outcome.skills);
  if (grants.unresolvedEntries.length > 0) {
    this.logger?.warn("Subagent skill entries matched no discovered skill", {
      agentType: request.agentType,
      event: "subagent.skill_grants.unresolved",
      unresolvedSkills: [...grants.unresolvedEntries],
    });
  }
  return new FilteredSkillPort(this.skillPort, grants.identities, entries, cuaPolicy);
}

class FilteredSkillPort implements SkillPort {
  constructor(
    private readonly parent: SkillPort,
    /** Frozen physical identities; undefined means the profile declares no skill list. */
    private readonly grants: ReadonlySet<string> | undefined,
    /** Profile entries, kept only for error context. */
    private readonly declaredSkills: readonly string[],
    private readonly cuaPolicy: OfficialCuaPolicy,
  ) {}

  async discoverSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    const outcome = await this.parent.discoverSkills(request, options);
    const nonCuaSkills = outcome.skills.filter((skill) => !this.cuaPolicy.isOfficialSkill(skill));
    const skills = this.grants
      ? filterSkillsByGrants(nonCuaSkills, this.grants)
      : nonCuaSkills;
    return {
      ...outcome,
      skills,
      totalDiscovered: skills.length,
    };
  }

  async loadSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    if (
      this.cuaPolicy.isOfficialSkillRequest(request.name) ||
      (await this.hasUniqueOfficialSkillMatch(request, options))
    ) {
      throw createSubagentComputerUseUnavailableError(request.name);
    }
    const resolved = await this.resolveAllowedSkill(request, options);
    if (!resolved) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill is not allowed for subagent",
        {
          context: {
            allowedSkills: [...this.declaredSkills],
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    // Load the exact file that passed the filter; the parent must not re-resolve by name.
    return this.parent.loadSkill(
      { ...request, name: resolved.qualifiedName ?? resolved.name, path: resolved.path },
      options,
    );
  }

  private async hasUniqueOfficialSkillMatch(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<boolean> {
    if (request.name.includes(":")) return false;
    const outcome = await this.parent.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    return isUniqueOfficialSkillRequest(outcome.skills, request.name, this.cuaPolicy);
  }

  private async resolveAllowedSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent["metadata"] | undefined> {
    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    const matches = outcome.skills.filter((skill) => matchesSkillRequestName(skill, request.name));
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill name is ambiguous for subagent; use the fully qualified skill name",
        {
          context: {
            allowedSkills: [...this.declaredSkills],
            matchingSkills: matches.map((skill) => skill.qualifiedName ?? skill.name),
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    return matches[0];
  }
}

async function validateSubagentComputerUseConfiguration(
  request: ExploreSubagentRuntimeRequest,
  cuaPolicy: OfficialCuaPolicy,
  discovery: ProfileSkillDiscovery,
): Promise<void> {
  const explicitServer = request.profile.mcpServers?.find((serverName) =>
    cuaPolicy.serverNames.has(serverName.trim()),
  );
  const explicitTool = request.allowedTools.find(
    (toolName) =>
      cuaPolicy.isOfficialToolRequest(toolName) || cuaPolicy.isOfficialServerSelector(toolName),
  );
  let explicitSkill = request.profile.skills?.find((skillName) =>
    cuaPolicy.isOfficialSkillRequest(skillName),
  );
  if (!explicitSkill && discovery.status === "ok") {
    explicitSkill = request.profile.skills?.find((skillName) =>
      isUniqueOfficialSkillRequest(discovery.outcome.skills, skillName, cuaPolicy),
    );
  }
  if (!explicitServer && !explicitTool && !explicitSkill) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        agentType: request.agentType,
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        ...(explicitServer ? { mcpServer: explicitServer } : {}),
        ...(explicitTool ? { mcpTool: explicitTool } : {}),
        ...(explicitSkill ? { skill: explicitSkill } : {}),
      },
      recoverable: true,
    },
  );
}

export function isUniqueOfficialSkillRequest(
  skills: readonly SkillContent["metadata"][],
  requestName: string,
  cuaPolicy: Pick<OfficialCuaPolicy, "isOfficialSkill">,
): boolean {
  if (requestName.includes(":")) return false;
  const matches = skills.filter((skill) => matchesSkillRequestName(skill, requestName));
  return matches.length === 1 && matches[0] !== undefined && cuaPolicy.isOfficialSkill(matches[0]);
}

function createSubagentComputerUseUnavailableError(skillName: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        skill: skillName,
        toolName: "Skill",
      },
      recoverable: true,
    },
  );
}

function matchesSkillRequestName(skill: SkillContent["metadata"], requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
