import { extname } from "node:path";
import { formatJson, type PresentationSurface } from "@zcode/core";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import {
  buildManualSkillPrompt,
  createCommandCenter,
  formatSlashCommandHelp,
  parseSlashCommand,
} from "./command-center.js";
import { loadCliDotenv } from "./env.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
import {
  createHeadlessPermissionBroker,
  createHeadlessSessionObserver,
  readHeadlessRuntimeFacts,
  waitForHeadlessWorkflowSettle,
} from "./headless-workflow.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { resolveResumeSession } from "./resume.js";
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import {
  DEFAULT_CLI_CLEANUP_TIMEOUT_MS,
  registerCliShutdownHandlers,
  runCliCleanupWithTimeout,
} from "./shutdown.js";
import { runSkillsCommand } from "./skills-command.js";
import {
  DEFAULT_CLI_WORKFLOW_MODE,
  isWorkflowModeEnabled,
  resolveWorkflowModeRuntimeConfig,
  WORKFLOW_DISABLED_NOTICE,
} from "./workflow-mode.js";
import type { DynamicWorkflowMode } from "@zcode/shared";
import type { CommandCenterApp, SlashCommand } from "./command-center.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

/**
 * Does this run print a JSON summary at the end?
 *
 * An explicit --output-format wins over the older --json flag, so that
 * `--output-format text` can turn the summary off again. Checking only
 * `options.json` here is a trap: `--output-format json` would parse fine and
 * then silently print plain text.
 */
const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

/** Does this run write each session event as it happens? */
const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
const EMPTY_PROMPT_ERROR = "--prompt requires non-empty text.";
const MEMORY_BENCH_DISABLED_ERROR =
  "--memory-bench requires Project Memory to be enabled (features.memory=true and memory.use=true).";
const TARGET_SELECTION_UNAVAILABLE_ERROR =
  "Headless goal commands cannot open an interactive replacement picker. Re-run with --target-replace or use /goal replace <objective>.";

export const runPrompt = async (
  ctx: RunContext,
  prompt: string,
  attachmentPaths: string[],
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest: CliResumeRequest = { continueSession: false },
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  presentationSurface: PresentationSurface = "terminal",
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
): Promise<number> => {
  if (prompt.trim().length === 0) {
    ctx.stderr.write(`${EMPTY_PROMPT_ERROR}\n`);
    return 1;
  }

  const slashCommand = parseSlashCommand(prompt);
  if (slashCommand?.type === "known" && slashCommand.name === "help") {
    ctx.stdout.write(
      `${formatSlashCommandHelp(slashCommand.args, await listCustomCommandsForPrompt(deps), {
        workflowMode,
      })}\n`,
    );
    return 0;
  }
  // With workflows disabled, `/workflow` is not expanded (as determined by the builtin resolver).
  // If the app were created and submitted normally, the original text would be sent to the model and
  // exit "successfully," which scripts could not detect. Fail before creating the app, using the same
  // local message as the TUI.
  if (
    slashCommand?.type === "known" &&
    slashCommand.name === "workflow" &&
    !isWorkflowModeEnabled(workflowMode)
  ) {
    ctx.stderr.write(`Error: ${WORKFLOW_DISABLED_NOTICE}\n`);
    return 1;
  }
  if (slashCommand?.type === "known" && slashCommand.name === "skill" && !slashCommand.skillName) {
    return await runSkillsCommand(ctx, options, deps, []);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "login") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /login\n");
      return 1;
    }
    return await runLoginCommand(ctx, options, deps, false);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "logout") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /logout\n");
      return 1;
    }
    return await runLogoutCommand(ctx, options, deps);
  }

  const runtimePrompt =
    slashCommand?.type === "known" && slashCommand.name === "skill"
      ? buildManualSkillPrompt(slashCommand.skillName, slashCommand.task)
      : prompt;

  let traceId: string | undefined;
  let app:
    | Awaited<ReturnType<Awaited<ReturnType<typeof loadBootstrapModule>>["createZCodeApp"]>>
    | undefined;
  let closePromise: Promise<void> | undefined;
  let browserRuntime: ReturnType<typeof createCliHeadlessBrowserRuntime>;
  let shutdownTelemetry: (() => Promise<void>) | undefined;
  // Handle for removing the persistent event subscription. Declare it here rather than
  // inside try so finally can always clean it up; no early return (command-center path
  // or exception) may leave a sink writing to stdout.
  let detachEvents: (() => void) | undefined;
  const stopObservingEvents = () => {
    detachEvents?.();
    detachEvents = undefined;
  };
  let providerRegistryRuntime: Awaited<
    ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
  >;
  const abortController = new AbortController();
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  const closeApp = async (): Promise<void> => {
    const targetApp = app;
    closePromise ??= (async () => {
      await runCliCleanupWithTimeout(async () => targetApp?.close?.(), cleanupTimeoutMs);
      // The CLI adapter owns the Browser process; even if App.close hangs or fails, Chromium must still be cleaned up.
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      // Root cause: App.close only ends the Session and flushes; the shared OTLP Owner
      // previously had no process-level terminal state. A single prompt is the outermost
      // lifecycle, so it must shut down symmetrically with prepare.
      await runCliCleanupWithTimeout(async () => shutdownTelemetry?.(), cleanupTimeoutMs);
      providerRegistryRuntime?.dispose();
    })();
    await closePromise;
  };
  const unregisterShutdownHandlers = registerCliShutdownHandlers({
    abort: (signal) => abortController.abort(new Error(`CLI received ${signal}`)),
    cleanup: closeApp,
    cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
    exitProcess: deps.exitProcess,
    process: deps.shutdownProcess,
  });
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const sessionId = await resolveResumeSession(resumeRequest, workingDirectory, env, deps);
    const bootstrapModule = deps.createZCodeApp ? undefined : await loadBootstrapModule();
    const createApp = deps.createZCodeApp ?? bootstrapModule?.createZCodeApp;
    if (!createApp) throw new Error("ZCode app factory is unavailable.");
    const streamsEvents = wantsEventStream(options);
    let mapSessionEvent: NonNullable<RunDependencies["mapSessionEvent"]> | undefined;
    if (streamsEvents) {
      mapSessionEvent = deps.mapSessionEvent ?? bootstrapModule?.mapSessionEvent;
      if (!mapSessionEvent) {
        throw new Error("Event streaming is unavailable: the bootstrap module did not load.");
      }
    }
    const observer = createHeadlessSessionObserver({
      ...(mapSessionEvent ? { mapSessionEvent } : {}),
      options,
      stderr: ctx.stderr,
      stdout: ctx.stdout,
    });
    const prepareTelemetry =
      deps.prepareZCodeTelemetryEnv ?? bootstrapModule?.prepareZCodeTelemetryEnv;
    if (prepareTelemetry) {
      shutdownTelemetry = deps.shutdownZCodeTelemetry ?? bootstrapModule?.shutdownZCodeTelemetry;
    }
    const appEnv = prepareTelemetry
      ? await prepareTelemetry(env, {
          cliVersion: version,
          productVersion: env.ZCODE_APP_VERSION,
        })
      : env;
    const startProviderRegistryRuntime =
      deps.startProcessProviderRegistryRuntime ??
      bootstrapModule?.startProcessProviderRegistryRuntime;
    if (!startProviderRegistryRuntime) {
      throw new Error("Provider Registry runtime is unavailable.");
    }
    providerRegistryRuntime = await startProviderRegistryRuntime(
      appEnv,
      deps.skipUserConfig
        ? {}
        : {
            standalone: {
              ...createCliProviderRefreshReporter(ctx.stderr),
              ...(deps.userConfigPath ? { legacyCliUserConfigFilePath: deps.userConfigPath } : {}),
            },
          },
    );
    const createProviderEndpointRoutingPort =
      deps.createProviderEndpointRoutingPort ??
      bootstrapModule?.createDefaultProviderEndpointRoutingPort;
    const providerEndpointRoutingPort = createProviderEndpointRoutingPort?.({
      appVersion: version,
      env,
      workingDirectory,
    });
    browserRuntime = createCliHeadlessBrowserRuntime(options, deps);
    app = await createApp({
      browserControlPort: browserRuntime?.browserControlPort,
      env: appEnv,
      // Headless mode has no interactive approval surface, so core falls back to a deny
      // broker and CreateWorkflow's alwaysAsk gate is **always denied** under -p
      // ("No permission client configured"). This minimal broker allows only CreateWorkflow
      // by tool name and delegates all other tools to the same deny broker, preserving
      // their exact behavior. See the comment in headless-workflow.ts.
      permissionBroker: createHeadlessPermissionBroker(),
      ...(providerEndpointRoutingPort ? { providerEndpointRoutingPort } : {}),
      providerRegistry: providerRegistryRuntime.runtime.registryService,
      configuredDefaultModelSelection: providerRegistryRuntime.configuredDefaultModelSelection,
      ...(providerRegistryRuntime.providerRuntimeHeadersPort
        ? {
            providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
          }
        : {}),
      resume: sessionId !== undefined,
      runtimeConfig: {
        ...(mode ? { mode } : {}),
        ...(toolDisallowlist ? { toolDisallowlist } : {}),
        ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
        ...resolveWorkflowModeRuntimeConfig(workflowMode),
        memory: { extractionEnabled: options.memoryBench === true },
        modelStreaming: "on",
        presentationSurface,
        workingDirectory,
      },
      sessionId,
      uiDetectedLocale: options.detectedLocale,
      uiLocale: options.locale,
      version,
    });
    // A shutdown signal may arrive during asynchronous identity import, before the
    // existing cleanup can access this App. Release the late instance separately, block
    // further submissions, and do not restart process-level cleanup that already ended.
    if (abortController.signal.aborted) {
      const lateApp = app;
      app = undefined;
      await runCliCleanupWithTimeout(async () => lateApp.close?.(), cleanupTimeoutMs);
      throw abortController.signal.reason;
    }
    traceId = app.traceId;
    if (options.memoryBench && !app.runtime.isProjectMemoryEnabled()) {
      throw new Error(MEMORY_BENCH_DISABLED_ERROR);
    }

    // Route by **resolvability**, not spelling.
    //
    // Custom commands all parse as `type === "unknown"`, so previously every one exited
    // through command-center. That path submits on its own and returns, skipping the
    // three mechanisms below that exist only on the ordinary prompt path: waiting for
    // dwf settlement, the single writer for persistent event subscriptions, and using
    // the final turn for `response`. As a result, `zcode -p "/workflow ..."` exited after
    // the first turn and orphaned the in-flight run as Interrupted. A resolvable custom
    // command must use the ordinary prompt path and submit the **original text**; the
    // facade's customCommandPromptResolver expands it server-side ($ARGUMENTS, skills:
    // preamble, `!`). Keep unresolved names in command-center for its "Unknown command"
    // message. Reserved names (only `/compress` parses as unknown in the CLI but is
    // rejected by the facade) stay there too. Both gates use the same predicate; see
    // isResolvableCustomCommand. `/expert` and `/goal` never reach submitPrompt, so their
    // routing remains unchanged.
    if (slashCommand && (await routesToPromptCommandCenter(slashCommand, deps))) {
      return await runPromptCommandCenterCommand(
        ctx,
        options,
        app as ModeCapableApp,
        prompt,
        mode,
        traceId,
        abortController.signal,
        deps,
        workflowMode,
      );
    }

    // The **single writer** for events. The persistent subscription survives across
    // turns and includes turns driven by completion notifications (started by core;
    // `runtime-command-queue.ts:336`). Per-turn `onEvent` is removed in submitPrompt's
    // finally block (`input-facade.ts:361-372`) and cannot see those turns.
    //
    // Never install both: if both sinks write the same event, the NDJSON row is
    // duplicated. Choose one rather than installing both and deduplicating by id; this
    // makes exactly-once delivery structural and independent of sink call order.
    //
    // Install this deliberately **after** the command-center branch: `/expert` and
    // `/goal` never reach submitPrompt and previously emitted no event rows. Installing
    // it earlier would add NDJSON rows to those paths.
    const subscribeEvents = readRuntimeEventSubscriber(app.runtime);
    detachEvents = subscribeEvents?.({ onSessionEvent: observer.observe });
    const runtimeFacts = readHeadlessRuntimeFacts(app.runtime);
    const result = await app.submitPrompt(
      attachmentPaths.length > 0
        ? {
            text: runtimePrompt,
            attachments: attachmentPaths.map((path) => ({
              type: inferAttachmentTypeFromPath(path),
              path,
            })),
          }
        : runtimePrompt,
      {
        abortSignal: abortController.signal,
        // Once the persistent subscription is installed, never install a per-turn sink (see the single-writer comment above).
        ...(detachEvents ? {} : { onEvent: observer.observe }),
      },
    );
    // Run this synchronously immediately after submitPrompt. No event can interleave
    // before the first await, so even if a run settles within the turn and its
    // notification turn has already started, its first event is not missed.
    observer.beginWaitPhase(result.turnId ? String(result.turnId) : undefined);
    traceId = result.traceId ?? traceId;
    // Do not orphan an in-flight workflow run when the process exits. Use a narrow
    // trigger (dwf activity was observed) and a broad drain (both runtime busy facts);
    // see the comment in waitForHeadlessWorkflowSettle for the reasoning.
    if (observer.hasWorkflowActivity() && runtimeFacts) {
      await waitForHeadlessWorkflowSettle({
        runtime: runtimeFacts,
        signal: abortController.signal,
      });
    }
    // Wait for the benchmark normally before close; close cancels Extraction and has its own cleanup timeout.
    if (options.memoryBench) {
      await app.runtime.drainMemoryExtractions(null);
      abortController.signal.throwIfAborted();
    }
    // Never emit event rows after the result row: stream-json result terminates the stream.
    stopObservingEvents();
    // Take `response` from the **last** turn: the summary after workflow settlement is
    // the answer. If no wait was needed, the array has one entry and response equals
    // result.response byte-for-byte.
    const turnResponses = [result.response, ...observer.waitPhaseTurnResponses()].filter(
      (text) => text.trim().length > 0,
    );
    const response = turnResponses.at(-1) ?? result.response;
    // Include the array only when there is more than one turn, keeping JSON output for
    // single-turn runs byte-for-byte unchanged. Inline this conditional in both summary
    // objects instead of sharing a variable: a variable of the expanded union type makes
    // TypeScript infer an optional key (`turnResponses?: string[]`), while formatJson
    // accepts only JsonValue.
    const multiTurn = turnResponses.length > 1;
    const hookTrustDiagnostic = await resolveHeadlessWorkspaceHookTrustDiagnostic({
      bootstrapModule,
      deps,
      events: result.events,
      workingDirectory,
    });

    if (streamsEvents) {
      // Closing summary, on its own line and tagged so it can be told apart
      // from the events preceding it. Same fields as --json, so a caller that
      // already parses that keeps working.
      ctx.stdout.write(
        `${JSON.stringify({
          type: "result",
          sessionId: app.sessionId,
          traceId,
          ...(result.turnId ? { turnId: result.turnId } : {}),
          response,
          ...(multiTurn ? { turnResponses } : {}),
          ...(result.usage ? { usage: { ...result.usage } } : {}),
          eventCount: result.events.length,
          projection: {
            status: result.projection.status,
            turnCount: result.projection.turnCount,
            totalTokenCount: result.projection.totalTokenCount,
            contextUsed: result.projection.contextUsed ?? null,
            contextWindow: result.projection.contextWindow ?? null,
          },
        })}\n`,
      );
      return 0;
    }

    if (wantsJsonSummary(options)) {
      ctx.stdout.write(
        formatJson({
          sessionId: app.sessionId,
          traceId,
          ...(result.turnId ? { turnId: result.turnId } : {}),
          response,
          ...(multiTurn ? { turnResponses } : {}),
          ...(result.usage ? { usage: { ...result.usage } } : {}),
          eventCount: result.events.length,
          ...(hookTrustDiagnostic
            ? {
                workspaceHookTrust: {
                  workspacePath: hookTrustDiagnostic.workspacePath,
                  workspaceIdentity: hookTrustDiagnostic.workspaceIdentity,
                  bundleDigest: hookTrustDiagnostic.bundleDigest,
                  reasonCode: hookTrustDiagnostic.reasonCode,
                  items: hookTrustDiagnostic.items.map((item) => ({
                    reviewItemId: item.reviewItemId,
                    event: item.event,
                    matcher: item.matcher,
                    displayCommand: item.displayCommand,
                    sourcePath: item.sourcePath,
                    configuredEnabled: item.configuredEnabled,
                    hookDeclarationDigest: item.hookDeclarationDigest,
                    trustState: item.trustState,
                  })),
                },
              }
            : {}),
          projection: {
            status: result.projection.status,
            turnCount: result.projection.turnCount,
            totalTokenCount: result.projection.totalTokenCount,
            contextUsed: result.projection.contextUsed ?? null,
            contextWindow: result.projection.contextWindow ?? null,
          },
        }),
      );
      return 0;
    }

    if (hookTrustDiagnostic) writeHeadlessWorkspaceHookTrustDiagnostic(ctx, hookTrustDiagnostic);
    // Print turn text in arrival order, so the final segment is naturally the summary
    // after settlement. For one turn this matches `${result.response}\n` byte-for-byte.
    ctx.stdout.write(`${turnResponses.join("\n\n")}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}${traceId ? ` (traceId: ${traceId})` : ""}\n`);
    if (options.verbose) {
      if (error instanceof Error && error.cause) {
        ctx.stderr.write(`Cause: ${error.cause}\n`);
      }
      if (error instanceof Error && error.stack) {
        ctx.stderr.write(`${error.stack}\n`);
      }
    }
    return 1;
  } finally {
    stopObservingEvents();
    unregisterShutdownHandlers();
    await closeApp();
  }
};

function inferAttachmentTypeFromPath(path: string): "file" | "image" | "video" | "pdf" {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === ".pdf") return "pdf";
  return "file";
}

const customCommandNotFoundPattern = /not found/i;

/** Should this slash command use command-center instead of the ordinary prompt path in headless mode? */
async function routesToPromptCommandCenter(
  slashCommand: SlashCommand,
  deps: RunDependencies,
): Promise<boolean> {
  if (slashCommand.type === "known") {
    return slashCommand.name === "expert" || slashCommand.name === "goal";
  }
  return !(await isResolvableCustomCommand(deps, slashCommand.rawName));
}

async function isResolvableCustomCommand(deps: RunDependencies, name: string): Promise<boolean> {
  // Check reserved names before attempting to load, matching the facade gate's exact
  // order (`bootstrap/src/custom-command-prompt.ts:31`). Use the same predicate: the
  // facade returns undefined for reserved names without expanding them. If this check
  // considered one resolvable, literal `/compress …` would be submitted as a normal
  // prompt, silently taking the wrong path without an error.
  //
  // Probe with the pair "reserved-name check + load" rather than calling
  // resolveZCodeCustomCommandPrompt directly: that function executes `!` shell expansion,
  // so using it to probe would run the user's shell fragment twice. This pair is its
  // side-effect-free equivalent (load only reads the file).
  if (await isReservedSlashCommandName(deps, name)) return false;
  try {
    await loadCustomCommandForPrompt(deps, name);
    return true;
  } catch (error) {
    // Only "not found" means unresolvable, matching buildCustomCommandPrompt. Disk
    // errors, invalid frontmatter, and similar failures must propagate; treating them as
    // unknown commands would replace the real cause with "Unknown command".
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function isReservedSlashCommandName(deps: RunDependencies, name: string): Promise<boolean> {
  if (deps.isReservedSlashCommandName) return deps.isReservedSlashCommandName(name);
  const bootstrap = await loadBootstrapModule();
  return bootstrap.isReservedZCodeSlashCommandName(name);
}

async function runPromptCommandCenterCommand(
  ctx: RunContext,
  options: GlobalOptions,
  app: ModeCapableApp,
  prompt: string,
  mode: CliPermissionMode | undefined,
  traceId: string | undefined,
  abortSignal: AbortSignal,
  deps: RunDependencies,
  workflowMode: DynamicWorkflowMode,
): Promise<number> {
  const commandCenter = createCommandCenter({
    getApp: async () => app as unknown as CommandCenterApp,
    getMode: () => app.getMode?.() ?? mode ?? "build",
    listCustomCommands: () => listCustomCommandsForPrompt(deps),
    loadCustomCommand: (name) => loadCustomCommandForPrompt(deps, name),
    recordInputHistory: async (input, kind) => {
      await app.recordInputHistory?.(input, kind);
    },
    resumeApp: async () => app as unknown as CommandCenterApp,
    workflowMode,
    setLocale: async (locale) => {
      if (!app.setLocale) {
        throw new Error("Locale switching is not available in this client.");
      }
      return await app.setLocale(locale);
    },
    setMode: async (nextMode) => {
      if (app.setMode) {
        const result = await app.setMode(nextMode);
        return result.mode;
      }
      app.runtime.updateConfig({ mode: nextMode });
      return nextMode;
    },
  });
  const result = await commandCenter(prompt, {
    abortSignal,
  });
  const nextTraceId = result.traceId ?? traceId;
  if (result.selection) {
    ctx.stderr.write(
      `Error: ${result.response}\n${TARGET_SELECTION_UNAVAILABLE_ERROR}${nextTraceId ? ` (traceId: ${nextTraceId})` : ""}\n`,
    );
    return 1;
  }

  if (options.memoryBench) {
    await app.runtime.drainMemoryExtractions(null);
    abortSignal.throwIfAborted();
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: String(app.sessionId),
        ...(nextTraceId ? { traceId: nextTraceId } : {}),
        response: result.response,
      }),
    );
    return 0;
  }

  ctx.stdout.write(`${result.response}\n`);
  return 0;
}

async function listCustomCommandsForPrompt(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

async function loadCustomCommandForPrompt(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

const HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS = [
  "workspace_hooks_pending_trust",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_feature_disabled",
] as const;
type HeadlessWorkspaceHookBlockReason = (typeof HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS)[number];

async function resolveHeadlessWorkspaceHookTrustDiagnostic(input: {
  bootstrapModule: Awaited<ReturnType<typeof loadBootstrapModule>> | undefined;
  deps: RunDependencies;
  events: readonly unknown[];
  workingDirectory: string;
}) {
  let reasonCode: HeadlessWorkspaceHookBlockReason | undefined;
  for (const event of input.events) {
    if (!event || typeof event !== "object") continue;
    const value = event as {
      type?: string;
      payload?: { errorCode?: string; descriptor?: { sourceKind?: string } };
    };
    if (value.type !== "hook_run_blocked" || value.payload?.descriptor?.sourceKind !== "project") {
      continue;
    }
    const errorCode = value.payload.errorCode;
    if (isHeadlessWorkspaceHookBlockReason(errorCode)) {
      reasonCode = errorCode;
      break;
    }
  }
  if (!reasonCode) return undefined;
  const inspect =
    input.deps.inspectWorkspaceHookTrust ?? input.bootstrapModule?.inspectWorkspaceHookTrust;
  if (!inspect) return undefined;
  const status = await inspect({
    workspacePath: input.workingDirectory,
    ...(input.deps.userConfigPath ? { userConfigPath: input.deps.userConfigPath } : {}),
  });
  return { ...status, reasonCode };
}

function isHeadlessWorkspaceHookBlockReason(
  value: string | undefined,
): value is HeadlessWorkspaceHookBlockReason {
  return HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS.some((candidate) => candidate === value);
}

function writeHeadlessWorkspaceHookTrustDiagnostic(
  ctx: RunContext,
  status: Awaited<ReturnType<NonNullable<RunDependencies["inspectWorkspaceHookTrust"]>>>,
): void {
  ctx.stderr.write(
    [
      `Workspace Hooks skipped: ${status.reasonCode}`,
      `workspace: ${status.workspaceIdentity}`,
      `bundle: ${status.bundleDigest ?? "none"}`,
      ...status.items
        .filter((item) => item.configuredEnabled && item.trustState !== "trusted_persistent")
        .map((item) => `pending digest: ${item.hookDeclarationDigest}`),
      `Review with: zcode hooks trust review --workspace ${JSON.stringify(status.workspaceIdentity)}`,
    ].join("\n") + "\n",
  );
}
import { createCliProviderRefreshReporter } from "./provider-runtime-env.js";
