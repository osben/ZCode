import { LOCAL_TTFT_MAX_PENDING, localTtftNow, type LocalTtftDetail } from "@zcode/shared";

type PreparationStage =
  | Exclude<LocalTtftDetail["stage"], "attempt" | "retry_wait" | "user_confirmation">
  | "execution";
export interface LocalTurnPreparationFact {
  sessionId: string;
  turnId: string;
  id: string;
  stage: PreparationStage;
  start: number;
  end?: number;
  outcome?: "completed" | "failed" | "cancelled";
}
type Subscription = { publish: (fact: LocalTurnPreparationFact) => void; sequence: number };
// Stores only the observation callback, not business input or phase facts; the CLI recorder
// owns the facts and subscription lifecycle.
const subscriptions = new Map<string, Subscription>();
const noop = () => {};
export function observeLocalTurnPreparation(
  inputId: string,
  publish: Subscription["publish"],
): () => void {
  if (subscriptions.size >= LOCAL_TTFT_MAX_PENDING || subscriptions.has(inputId)) return noop;
  const subscription = { publish, sequence: 0 };
  subscriptions.set(inputId, subscription);
  return () => {
    if (subscriptions.get(inputId) === subscription) subscriptions.delete(inputId);
  };
}
export function beginLocalTurnPreparation(
  trace: { queryId?: string; sessionId?: string; turnId?: string },
  stage: PreparationStage,
): (outcome?: LocalTurnPreparationFact["outcome"]) => void {
  const subscription = trace.queryId ? subscriptions.get(trace.queryId) : undefined;
  if (!subscription || !trace.sessionId || !trace.turnId) return noop;
  const fact: LocalTurnPreparationFact = {
    sessionId: trace.sessionId,
    turnId: trace.turnId,
    id: `prepare:${subscription.sequence++}`,
    stage,
    start: localTtftNow(),
  };
  const publish = (value: LocalTurnPreparationFact) => {
    // An observation callback failure must not change Core's return value or exception. Once
    // the first output unsubscribes, do not collect tool-loop events afterward.
    if (subscriptions.get(trace.queryId!) !== subscription) return;
    try {
      subscription.publish(value);
    } catch {
      /* Telemetry does not participate in business decisions. */
    }
  };
  publish(fact);
  let ended = false;
  return (outcome = "completed") => {
    if (ended) return;
    ended = true;
    publish({ ...fact, end: localTtftNow(), outcome });
  };
}
