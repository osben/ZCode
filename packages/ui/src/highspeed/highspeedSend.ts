import type {
  HighspeedCardSnapshot,
  HighspeedMessageMeta,
  HighspeedPrepareTurnResult,
  ModelSelection,
} from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";

/** Same shape as the protocol payload, so the Renderer does not maintain a separate execution-material type. */
type HighspeedModelExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

export type HighspeedTurnPreparer = (
  taskId: string,
  submissionSelection?: ModelSelection,
) => Promise<HighspeedPrepareTurnResult | null>;

/** Fields in the session projection/draft that can participate in Highspeed prepare selection resolution (structurally compatible with snapshot config). */
export interface HighspeedPrepareSelectionSource {
  readonly provider?: string;
  readonly model?: string;
  readonly thought?: string;
  readonly modelSelection?: ModelSelection;
}

/**
 * Resolves provider/model/reasoningLevel for the Highspeed prepare (spec §3 rule 15):
 * sourced from the submitted modelSelection — a model the user just switched to must drive
 * admission on the first send; drawing with the session projection's stale combination and then
 * overriding the submitted selection with the card model is forbidden. When the submitted
 * selection is missing, fall back field by field through session projection → draft → initial
 * draft; return null when provider or model cannot be resolved.
 */
export function resolveHighspeedPrepareSelection(input: {
  submissionSelection?: ModelSelection;
  projectedConfig?: HighspeedPrepareSelectionSource | null;
  draftConfig?: HighspeedPrepareSelectionSource | null;
  initialDraftConfig?: HighspeedPrepareSelectionSource | null;
}): { provider: string; model: string; reasoningLevel?: string } | null {
  const { submissionSelection } = input;
  const fallbacks = [input.projectedConfig, input.draftConfig, input.initialDraftConfig];
  const provider = submissionSelection?.providerId ?? fallbacks.find((c) => c?.provider)?.provider;
  const model = submissionSelection?.modelId ?? fallbacks.find((c) => c?.model)?.model;
  if (!provider || !model) return null;
  const reasoningLevel =
    submissionSelection?.options?.reasoningLevel ??
    fallbacks
      .map((c) => c?.thought || c?.modelSelection?.options?.reasoningLevel)
      .find((value) => !!value);
  return { provider, model, ...(reasoningLevel ? { reasoningLevel } : {}) };
}

export type HighspeedSendContext = {
  override: ReturnType<typeof buildHighspeedRuntimeOverride>;
  acceleratedCard?: HighspeedCardSnapshot;
};

/**
 * A mock draw still keeps the accelerated metadata but has no Highspeed execution material,
 * so only the message metadata is written and inference continues on the current session's
 * regular provider/model.
 *
 * Accelerating the turn is expressed via standard modelSelection + modelExecution
 * {selectionScope:"execution"}: static facts such as the endpoint come from the Built-in Provider
 * Config, and credentials belong only to this execution, not to the session's persistent
 * selection. See docs/highspeed/highspeed-access-mode-migration.md.
 */
export function buildHighspeedRuntimeOverride(
  result: HighspeedPrepareTurnResult | null | undefined,
): {
  highspeedMeta?: HighspeedMessageMeta;
  modelSelection?: ModelSelection;
  modelExecution?: HighspeedModelExecution;
} {
  if (result?.kind !== "accelerated") return {};
  const highspeedMeta: HighspeedMessageMeta = {
    schemaVersion: 1,
    ...result.card,
  };
  if (!result.execution) return { highspeedMeta };
  return {
    highspeedMeta,
    modelSelection: result.execution.modelSelection,
    modelExecution: {
      selectionScope: "execution",
      requestAuth: result.execution.requestAuth,
      selectionFallback: result.execution.selectionFallback,
    },
  };
}

/**
 * Assembles the Highspeed result before sending in one place, so each send path does not maintain
 * its own payload and Renderer stats card. The CLI remains the final admission authority; this
 * only splits one prepare's result into the two existing consumption shapes.
 */
export async function prepareHighspeedSendContext(
  taskId: string,
  prepareTurn: HighspeedTurnPreparer,
  submissionSelection?: ModelSelection,
): Promise<HighspeedSendContext> {
  const result = await prepareTurn(taskId, submissionSelection);
  return {
    override: buildHighspeedRuntimeOverride(result),
    ...(result?.kind === "accelerated" ? { acceleratedCard: result.card } : {}),
  };
}

/** Send wait budget: the draw waits at most this long before the regular send proceeds (spec §1, §3). */
export const HIGHSPEED_SEND_WAIT_BUDGET_MS = 1000;
/**
 * Wait cap for the regular decode TPS read on the send path. Enough to cover one RPC round trip
 * on a Service cache hit (including the mobile Web websocket round trip), deliberately not enough
 * to wait out a real monitor network request.
 */
export const HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS = 300;

/**
 * Decorative read on the send path (regularTps only drives the saved-time display, not auth,
 * model selection, or inference correctness): wait at most min(300ms, remaining 1s send budget);
 * on timeout or failure always return undefined so sendText submits immediately. The request
 * itself is not cancelled — the Service layer merges concurrent calls and caches for 5 minutes,
 * so the timed-out call finishing later just warms the cache and the next round hits it.
 *
 * Bug root cause: this read was previously awaited synchronously after a successful prepareTurn
 * draw, and its monitor-side 15s timeout stretched the 1s send promise to up to 16s (spec §3
 * rule 12, §9.4).
 */
export async function readRegularTpsWithinSendBudget(params: {
  read: () => Promise<number | undefined>;
  /** Milliseconds already consumed by this send from entering prepare until now, used to deduct the remaining budget. */
  elapsedMs: number;
  onError?: (error: unknown) => void;
  onTimeout?: (budgetMs: number) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<number | undefined> {
  const budgetMs = Math.max(
    0,
    Math.min(
      HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS,
      HIGHSPEED_SEND_WAIT_BUDGET_MS - params.elapsedMs,
    ),
  );
  // Attach the catch up front: a failure when the read completes in the background must never
  // become an unhandled rejection, whether or not we waited for the result.
  const reading = (async () => params.read())().then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => {
      params.onError?.(error);
      return { kind: "error" as const };
    },
  );
  if (budgetMs === 0) {
    params.onTimeout?.(0);
    return undefined;
  }
  const wait =
    params.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const outcome = await Promise.race([
    reading,
    wait(budgetMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (outcome.kind === "timeout") {
    params.onTimeout?.(budgetMs);
    return undefined;
  }
  return outcome.kind === "value" ? outcome.value : undefined;
}
