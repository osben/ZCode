import {
  AutomationCreateLimitError,
  hasRelativeDelayMinutes,
  isAutomationCreateLimitError,
  type AutomationPort,
  type CronAutomation,
} from "@zcode/contracts";
import {
  parseModelPickerValue,
  zcodeAutomationCheckTaskBindingResultSchema,
  zcodeAutomationCreateResultSchema,
  zcodeAutomationDeleteResultSchema,
  zcodeAutomationListResultSchema,
  zcodeAutomationPauseResultSchema,
  zcodeAutomationUpdateResultSchema,
  zcodeProtocolMethods,
  type ZCodeAutomationProtocol,
} from "@zcode/shared";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";

export const AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR =
  "Cannot create a scheduled task while running a scheduled task.";

export const AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR =
  "Cannot create a scheduled task inside a session that already belongs to a scheduled task. " +
  "Ask the user to start a new chat to create another scheduled task.";

export const AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session belongs to a scheduled task. Try again later.";

export function createProtocolAutomationPort(
  context: ZCodeProtocolAgentServerContext,
  // Session ownership resolver: automation-port is constructed per session, so bind directly to
  // the session record it serves. Do not rely on context.sessions lookup; V4/desktop sessions may
  // not be registered in that legacy map. Previously, this caused activeSession lookup to fail and
  // lose permission/reasoning level (only model creation survived due to its createContext fallback).
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): AutomationPort {
  // A shared connection must not borrow the first workspace; this includes list requests carrying only an automationId or empty params.
  const requestClient: typeof context.requestClient = (...args) => {
    if (!context.sessionWorkspaceRoutingEnabled) return context.requestClient(...args);
    const workspace = resolveOwnSession?.()?.workspace;
    if (!workspace) throw new Error("Session workspace is unavailable");
    const [method, params, schema, ...options] = args;
    return context.requestClient(method, { ...(params as object), workspace }, schema, ...options);
  };
  return {
    async create(input, createContext) {
      // Prefer the owned session (the session where this tool is running); fall back to looking up
      // createContext.sessionId in the legacy map.
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeAutomationId?.trim()) {
        // This turn was dispatched by automationId; another CronCreate would create a recursive
        // scheduled-task chain. This check happens within automation-port, so a match does not call
        // protocol automation/create.
        throw new Error(AUTOMATION_CREATE_FROM_AUTOMATION_RUN_ERROR);
      }
      // Desktop interactive input connects directly to the CLI (bypassing host adapter's
      // toolDenylist injection). If a user continues in a session bound to a scheduled task,
      // CronCreate remains registered with no per-turn filter and could bypass all previous guards.
      // Add an entry-point-independent guard based on targetTaskId: reject if the current session is
      // already bound to an automation (a scheduled-task session); allow the first creation in a
      // regular unbound session. Check ownership through the dedicated EXISTS protocol rather than
      // reading the full list, since a damaged display field in any historical task could otherwise
      // falsely make the current session "unverifiable."
      const ownSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (ownSessionId) {
        let bound: boolean;
        try {
          try {
            const result = await requestClient(
              zcodeProtocolMethods.automationCheckTaskBinding,
              { targetTaskId: ownSessionId },
              zcodeAutomationCheckTaskBindingResultSchema,
            );
            bound = result.bound;
          } catch (error) {
            if (!(error instanceof ProtocolRequestError && error.code === -32601)) {
              throw error;
            }
            // The protocol version is still 1, so the dedicated ownership method may return -32601
            // when an older Host remains connected before upgrading, or when connected remotely.
            // Only "method not found" proves a capability difference; fall back to filtering the old
            // list in that case. Database, transport, and protocol errors must remain fail-closed and
            // must not be mistaken for an unbound session.
            const legacyResult = await requestClient(
              zcodeProtocolMethods.automationList,
              {},
              zcodeAutomationListResultSchema,
            );
            bound = legacyResult.automations.some(
              (automation) => automation.targetTaskId === ownSessionId,
            );
          }
        } catch (error) {
          context.logger?.warn("Failed to check bound automations before CronCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "automation.create.bound_session_check.failed",
            sessionId: ownSessionId,
          });
          // Session ownership lookup is the authorization boundary preventing recursive CronCreate.
          // Unknown must not mean unbound, or a temporary host/database failure would re-enable
          // creation. Fail closed when the query fails.
          throw new Error(AUTOMATION_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) {
          throw new Error(AUTOMATION_CREATE_IN_BOUND_SESSION_ERROR);
        }
      }
      // CronCreate's tool context carries only part of the configuration, causing permission or
      // reasoning level to be lost across layers. Read the active runtime by sessionId at the
      // protocol boundary so the saved settings match what the user saw when invoking the tool.
      // Scheduled tasks inherit only the session's stable Selection: single-turn executions such
      // as speed-card runs go through modelExecution (selectionScope=execution) and never rewrite
      // the Session Selection, so what is read here is never a turn-only model, and there is no
      // need to distinguish persistent vs. temporary read paths.
      const runtimeModelSelection =
        activeSession?.app.runtime.getSessionModelSelection() ??
        (() => {
          try {
            return createContext?.model ? parseModelPickerValue(createContext.model) : undefined;
          } catch {
            return undefined;
          }
        })();
      const runtimeMode = activeSession?.app.getMode();
      const hasIntervalCarrier = input.intervalUnit !== undefined && input.interval !== undefined;
      let result;
      try {
        result = await requestClient(
          zcodeProtocolMethods.automationCreate,
          {
            // Do not have the model convert relative time to an absolute instant; the compatibility
            // protocol still requires cronExpr, and the service replaces the placeholder using the
            // real clock. Checking `!== null` would send a regular cron call with omitted delayMinutes
            // down the relative path and force recurring=false. hasRelativeDelayMinutes (an explicit
            // number) is the sole indication of a relative task.
            cronExpr: input.cron ?? "* * * * *",
            ...(hasRelativeDelayMinutes(input) ? { relativeDelayMinutes: input.delayMinutes } : {}),
            prompt: input.prompt,
            title: input.title,
            recurring: hasRelativeDelayMinutes(input)
              ? false
              : hasIntervalCarrier
                ? true
                : (input.recurring ?? true),
            // The protocol server still injects workspace from the current session.
            ...(runtimeModelSelection ? { modelSelection: runtimeModelSelection } : {}),
            ...(runtimeMode ? { mode: runtimeMode === "auto" ? "build" : runtimeMode } : {}),
            ...(createContext?.sessionId ? { targetTaskId: createContext.sessionId } : {}),
            ...(activeSession?.activeBotDeliveryTarget
              ? { botDeliveryTarget: activeSession.activeBotDeliveryTarget }
              : {}),
            ...(hasIntervalCarrier
              ? {
                  // Do not forward a finite limit when creating a new carrier; the create protocol
                  // has no maxRuns=null semantics for clearing it.
                  intervalUnit: input.intervalUnit,
                  interval: input.interval,
                }
              : input.maxRuns !== undefined
                ? { maxRuns: input.maxRuns }
                : {}),
          },
          zcodeAutomationCreateResultSchema,
        );
      } catch (error) {
        if (!isAutomationCreateLimitError(error)) throw error;
        // Protocol errors used to enter the tool loop as ordinary Error values. The model treated
        // deletion advice in the error as an executable recovery step and repeatedly called
        // CronList/CronDelete/CronCreate. Map them to stable domain errors so core can close the
        // current turn's tool-recovery boundary without depending on shared implementation details.
        throw new AutomationCreateLimitError(
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      const automation = toCronAutomation(result.automation);
      const title = automation.title.trim();
      if (activeSession && title.length > 0) {
        try {
          // CronCreate within a session creates an automation during the first reply, but the
          // session_title sidecar triggered by the first message may arrive later and generate a title
          // from the assistant's explanation, such as "I can't...". After CronCreate succeeds, pin
          // the current session title to the automation title so generated titles cannot overwrite it.
          await activeSession.app.setCustomSessionTitle({
            title,
            traceContext: activeSession.traceContext,
          });
        } catch (error) {
          context.logger?.warn("Failed to freeze session title after CronCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "automation.session_title_freeze.failed",
            sessionId: createContext?.sessionId,
          });
        }
      }
      return automation;
    },
    async update(input) {
      const hasIntervalCarrier = input.intervalUnit !== undefined && input.interval !== undefined;
      const result = await requestClient(
        zcodeProtocolMethods.automationUpdate,
        {
          automationId: input.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.cron !== undefined ? { cronExpr: input.cron } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(hasIntervalCarrier
            ? {
                // A historical one-shot task would preserve recurring=false when forwarded through
                // the carrier and be marked completed by the repository after its first dispatch.
                // Atomically switch the carrier to an unbounded recurrence at the protocol boundary.
                recurring: true,
                maxRuns: null,
                intervalUnit: input.intervalUnit,
                interval: input.interval,
              }
            : {
                ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
                ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
              }),
        },
        zcodeAutomationUpdateResultSchema,
      );
      return toCronAutomation(result.automation);
    },
    async list() {
      const result = await requestClient(
        zcodeProtocolMethods.automationList,
        {},
        zcodeAutomationListResultSchema,
      );
      return result.automations.map(toCronAutomation);
    },
    async delete(input) {
      const result = await requestClient(
        zcodeProtocolMethods.automationDelete,
        { automationId: input.id },
        zcodeAutomationDeleteResultSchema,
      );
      return result.deleted;
    },
    async pause(input) {
      // The target id is injected from the loop automationId by the core executor; here it is only passed through to the Host for conditional pause.
      // Older Hosts that do not know automation/pause return -32601, which bubbles up as a tool error with no fallback.
      const result = await requestClient(
        zcodeProtocolMethods.automationPause,
        { automationId: input.id },
        zcodeAutomationPauseResultSchema,
      );
      return result.paused;
    },
  };
}

function normalizeCronAutomationMode(
  mode: ZCodeAutomationProtocol["mode"],
): CronAutomation["mode"] {
  switch (mode) {
    case undefined:
      return undefined;
    case "plan":
    case "edit":
    case "guarded":
    case "yolo":
    case "build":
      return mode;
    case "dontAsk":
    case "bypassPermissions":
      return "yolo";
    case "default":
    case "auto":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default: {
      const exhaustiveMode: never = mode;
      return exhaustiveMode;
    }
  }
}

function toCronAutomation(input: ZCodeAutomationProtocol): CronAutomation {
  return {
    automationId: input.automationId,
    title: input.title,
    cronExpr: input.cronExpr,
    prompt: input.prompt,
    enabled: input.enabled,
    lifecycleStatus: input.lifecycleStatus,
    nextRunAt: input.nextRunAt,
    lastRunAt: input.lastRunAt,
    runCount: input.runCount,
    recurring: input.recurring,
    maxRuns: input.maxRuns,
    modelSelection: input.modelSelection,
    // Explicitly fall back to the existing session-permission semantics; exhaustive checks will
    // require synchronization if the protocol adds another mode.
    mode: normalizeCronAutomationMode(input.mode),
    // Forward the authoritative scheduleRule. Session cards need this field to display real
    // intervals that cron cannot represent (such as every 50 hours or every 40 days); otherwise,
    // they can only infer incorrect displays such as "at minute 00 every hour" from cronExpr.
    scheduleRule: input.scheduleRule,
  };
}
