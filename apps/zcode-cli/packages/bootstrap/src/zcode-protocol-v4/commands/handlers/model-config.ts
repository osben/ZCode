// Model configuration command group: switchModelConfig (ported from the legacy
// server-operations.switchModelConfig semantics), switchCollaborationMode (additive, for the UI mode
// selector), and applyRequestedSessionConfig (shared consumer of createSession.config).
// One file per command group: the handler is a pure function (host, envelope) -> CommandResult|undefined.
// Decision logic directly invokes core (app.setModel / app.setMode / runtime.emit*), bypassing legacy protocol ops.
import type { CollaborationMode, ModelSelection } from "@zcode/contracts";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { runSessionModelConfigMutation } from "../../model-config-mutation.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/** No-op reasonCode for a switch to the same value. */
const CONFIG_UNCHANGED = "config.unchanged";

/**
 * The target Provider is absent from the current Environment Registry. Gateway maps this to a failed
 * ACK; the caller must refresh the current Environment's Provider Config instead of pushing the Host Snapshot to the Worker again.
 */
class V4ProviderNotInRegistryError extends Error {
  readonly reasonCode = "provider.notInRegistry";
  constructor(providerId: string) {
    super(`provider "${providerId}" is not in the workspace model registry`);
  }
}

/**
 * Confirm that the target Provider exists in the current Environment Registry before switching
 * models. Convert `applied:false` to a structured domain error (gateway -> failed ACK). Preserve the
 * old Entry behavior if the Host did not inject this capability.
 */
async function ensureProviderClientReady(
  host: V4CommandCoreHost,
  sessionId: string,
  providerId: string,
): Promise<void> {
  if (!host.ensureProviderAvailable) return;
  const outcome = await host.ensureProviderAvailable(sessionId, providerId);
  if (!outcome.available && outcome.reason === "provider_not_in_registry") {
    throw new V4ProviderNotInRegistryError(providerId);
  }
  // Other reasons such as session_not_found should be unreachable because requireRecord already
  // validates on the handler side. Do not throw in the fallback: let setModel follow its existing
  // path and report the real lookup error.
}

function createModelSelection(provider: string, model: string, thought: string | undefined) {
  return {
    providerId: provider,
    modelId: model,
    ...(thought ? { options: { reasoningLevel: thought } } : {}),
  };
}

function readActualThought(
  record: V4SessionRecordView,
  fallbackSelection?: ModelSelection,
): string {
  const thought = record.app.getThoughtLevel();
  if (thought !== undefined) return thought;
  return fallbackSelection?.options?.reasoningLevel ?? "";
}

/** switchCollaborationMode command values (same source as command.ts z.enum; excludes auto, which users cannot select). */
const SWITCHABLE_MODES: ReadonlySet<string> = new Set(["build", "edit", "plan", "yolo"]);

/**
 * switchModelConfig: change the session's model selection. For a different model, app.setModel
 * switches the provider client and model. For the same model, only thought represents an explicit
 * reasoning-depth change; then emit ModelSelected. The v4 projection's config update and the
 * mid-turn modelChange marker both depend on this event (reducer onModelSelected).
 *
 * Behavioral parity: the legacy protocol path has no active-turn guard and allows switching while
 * running, so this handler preserves that behavior.
 */
async function switchModelConfig(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
  const record = requireRecord(host, envelope.sessionId);
  return runSessionModelConfigMutation(record.app, async () => {
    // Snapshot previous inside the serialization critical section and before setModel. A registry
    // fallback may be queued ahead of this command; reading before queuing could capture a stale value
    // and make no-op/event ordering diverge from runtime truth.
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const modelIdentityChanged =
      previousSelection?.providerId !== payload.provider ||
      previousSelection?.modelId !== payload.model;
    const requestedThought = payload.thought.trim();
    const thoughtChanged =
      Boolean(requestedThought) && requestedThought !== previousSelection?.options?.reasoningLevel;
    // Finalize a switch to the same value as a no-op ACK (config.unchanged). Do not silently consume it
    // as accepted: after seed alignment, the UI value equals runtime truth, and clients use this result
    // to distinguish "applied" from "already selected".
    if (!modelIdentityChanged && !thoughtChanged) {
      throw new V4CommandNoopError(CONFIG_UNCHANGED);
    }
    // Confirm the target Provider is available in the current Environment Registry before setModel.
    await ensureProviderClientReady(host, record.app.sessionId, payload.provider);
    let actualThought = previousThought;
    let nextModelSelection: ModelSelection;
    if (modelIdentityChanged) {
      const result = await record.app.setModel(`${payload.provider}/${payload.model}`);
      actualThought = result.thoughtLevel ?? readActualThought(record);
      if (requestedThought && record.app.listThoughtLevels().includes(requestedThought)) {
        // Explicitly choosing the default level is still a pin. Call the setter so Session
        // Selection stores this explicit leaf; do not discard the user's intent because the
        // effective value is unchanged.
        const thoughtResult = await record.app.setThoughtLevel(requestedThought);
        actualThought = thoughtResult.thoughtLevel;
      }
      nextModelSelection = createModelSelection(
        payload.provider,
        payload.model,
        requestedThought && record.app.listThoughtLevels().includes(requestedThought)
          ? requestedThought
          : undefined,
      );
    } else {
      // Treat thought as an explicit user change only when provider/model are unchanged; reject
      // invalid values before changing the model.
      const result = await record.app.setThoughtLevel(requestedThought);
      actualThought = result.thoughtLevel;
      nextModelSelection = createModelSelection(payload.provider, payload.model, actualThought);
    }
    await record.app.runtime.emitModelSelected({
      modelSelection: nextModelSelection,
      ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
      previousModelSelection,
      supportedThoughtLevels: record.app.listThoughtLevels(),
      // Pass through the trace chain from record (the session root trace); do not start an
      // unrelated traceId in the command layer.
      traceContext: record.traceContext,
    });
    return undefined;
  });
}

/**
 * switchCollaborationMode switches the agent collaboration mode (plan/build/edit/yolo).
 * app.setMode updates the separate execution state, persists it, and publishes
 * SessionModeChanged; the command layer must not publish a duplicate event.
 * The v4 projection reducer updates config.mode from onSessionModeChanged.
 * An unchanged mode returns a no-op ACK. Returning undefined silently would be treated as
 * accepted; if the projection seed is missing, the CLI may return early because it is already in
 * yolo while the projection remains at the seeded build mode, with no way for the client to detect
 * the mismatch. Therefore, ACK explicitly.
 */
async function switchCollaborationMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchCollaborationMode"];
  const record = requireRecord(host, envelope.sessionId);
  const mode = payload.mode as CollaborationMode;
  const previousMode = record.app.getMode();
  if (previousMode === mode && !record.app.runtime.getPlanEnabled()) {
    throw new V4CommandNoopError(CONFIG_UNCHANGED);
  }
  await record.app.setMode(mode);
  return undefined;
}

/**
 * Shared implementation for applying createSession.config (“createSession.config must be
 * consumed”): merge with request config overriding runtime defaults, and apply only values that
 * differ from the current runtime. Publish the same events as switch commands (ModelSelected /
 * SessionModeChanged) so logs are self-contained and the projection uses existing reducers rather
 * than a second write path.
 *
 * Use events instead of directly changing the seed because the publisher is created while wiring
 * the createSessionRecord event, and the seed reads runtime defaults before the request config is
 * applied. Publishing events both corrects the projection and logs which model was used initially,
 * so cold recovery can replay it. When prev is empty on the first selection, the reducer emits no
 * modelChange marker (onModelSelected treats the first selection as no switch), avoiding a noisy row.
 *
 * Partial failure semantics: if session creation succeeds, a config-application failure must not
 * fail createSession as well (leaking a record is not worth replacing it with a failed ACK). The
 * caller catches the error and downgrades it to a warning; the session keeps runtime defaults.
 */
export async function applyRequestedSessionConfig(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  config: NonNullable<CommandPayloadMap["createSession"]["config"]>,
): Promise<void> {
  await runSessionModelConfigMutation(record.app, async () => {
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const requestedSelection = config.modelSelection;
    const targetProvider =
      requestedSelection?.providerId ?? config.provider?.trim() ?? previousSelection?.providerId;
    const targetModel =
      requestedSelection?.modelId ?? config.model?.trim() ?? previousSelection?.modelId;
    const targetThought =
      requestedSelection?.options?.reasoningLevel ?? config.thought?.trim() ?? "";
    const modelIdentityChanged =
      targetProvider !== previousSelection?.providerId ||
      targetModel !== previousSelection?.modelId;
    const thoughtChanged =
      Boolean(targetThought) &&
      targetThought !==
        (requestedSelection ? previousSelection?.options?.reasoningLevel : previousThought);
    if (targetProvider && targetModel && (modelIdentityChanged || thoughtChanged)) {
      // If the initial Provider is not in the Registry, throw provider.notInRegistry. createSession
      // catches it and downgrades it to a warning; the session keeps runtime defaults and creation
      // succeeds, matching existing config-application failure semantics.
      await ensureProviderClientReady(host, record.app.sessionId, targetProvider);
      let actualThought = previousThought;
      if (modelIdentityChanged) {
        const result = await record.app.setModel(`${targetProvider}/${targetModel}`);
        actualThought = result.thoughtLevel ?? readActualThought(record);
      }
      if (targetThought && record.app.listThoughtLevels().includes(targetThought)) {
        const result = await record.app.setThoughtLevel(targetThought);
        actualThought = result.thoughtLevel;
      } else if (requestedSelection?.options?.reasoningLevel) {
        // Explicit options in the structured Selection must fail closed. Keep the published
        // compatibility behavior of using the default when the target does not support it only
        // for legacy flat config.
        await record.app.setThoughtLevel(targetThought);
      }
      if (modelIdentityChanged || actualThought !== previousThought) {
        // A draft-prewarm config may carry the previous model's thought setting. If the target
        // model does not support it, keep the compatible level already resolved by setModel and
        // still publish the target-model event to avoid splitting runtime and projection state.
        await record.app.runtime.emitModelSelected({
          modelSelection: createModelSelection(
            targetProvider,
            targetModel,
            targetThought && record.app.listThoughtLevels().includes(targetThought)
              ? targetThought
              : undefined,
          ),
          ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
          previousModelSelection,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          traceContext: record.traceContext,
        });
      }
    }
  });

  // mode: payload.config.mode is a broad string for schema-default compatibility; constrain its
  // value here.
  const mode = config.mode;
  if ((mode && SWITCHABLE_MODES.has(mode)) || config.planEnabled !== undefined) {
    await record.app.runtime.setExecutionState(
      {
        ...(mode && SWITCHABLE_MODES.has(mode) ? { mode } : {}),
        ...(config.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
      },
      record.traceContext,
    );
  }

  // followupMode defaults to queue in both runtime and projection. Write only non-default values:
  // runtime.setFollowupMode has no same-value guard and always appends an event, so explicitly
  // sending "queue" would create a no-op delta.
  if (config.followupMode && config.followupMode !== "queue") {
    await record.app.setFollowupMode(config.followupMode);
  }
}

export const modelConfigHandlers = { switchModelConfig, switchCollaborationMode };
