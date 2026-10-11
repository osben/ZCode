import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, sameModelSelection } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * Consume at most one guide at a valid model-step boundary and prepare the next provider request.
 * SendMessage may arrive while a child model request is in progress; if that step ends normally with text only,
 * waiting for a future tool batch would leave coordinator input permanently in a queue with no wake-up source.
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
    // A fixed execution model prevents model switching, but should not discard the Guide's permission/Plan intent.
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) {
      // Re-resolving configuration is not a model switch; compare the Loop's execution selection, not Session state that may have changed externally.
    const selectionChanged = !sameModelSelection(state.model, guideModel);
    state.model = guideModel;
    if (selectionChanged) {
      state.turnRequestState.entries = rebuildContextPrefix(runtime, {
        model: guideModel,
        turnRequestEntries: state.turnRequestState.entries,
      });
    }
  }
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.[0];
  if (nextQueryId) {
    // Continue the current active turn with the guide as a user role; attribute later requests to that input's query.
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // An automation guide does not start a new turn, so merge its restrictions into the current loop state.
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}
