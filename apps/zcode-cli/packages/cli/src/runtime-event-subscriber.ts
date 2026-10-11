// Read the runtime capability for cross-turn session-event subscription.
//
// Keep this separate because it has two different consumers: headless (`prompt-command.ts`)
// and TUI (`tui-prompt-handler.ts` → `tui-session-event-relay.ts`). The capability reader
// must not belong to either consumer. If placed in a headless-only module, the TUI would
// import a reader named Headless from a module named headless, misrepresenting its
// behavior. It answers only whether this runtime supports cross-turn subscription.
import type { SessionEvent } from "@zcode/contracts";

/**
 * Dynamically read a function member from `unknown`.
 *
 * Accept `unknown` and inspect the property dynamically **not** to defend against a real
 * `AgentRuntime` (these members are required there), but because
 * `RunDependencies.createZCodeApp` is a public injection point (see “tests, embedders”
 * in cli-types.ts), and test doubles can have any shape. TypeScript treats `?.` on a
 * required member as an always-true condition, so express the boundary here with one
 * explicit dynamic read.
 */
export const readRuntimeFunction = (
  source: unknown,
  key: string,
): ((...args: never[]) => unknown) | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
};

type RuntimeEventSubscriber = (sink: {
  onSessionEvent: (event: SessionEvent) => void;
}) => () => void;

/**
 * Read the runtime's cross-turn event subscription.
 *
 * **Do not silently degrade**: return `undefined` if subscription is unavailable, so the
 * caller falls back to per-turn `onEvent` (visible for one turn, matching previous
 * behavior). This honestly reports that the host lacks the capability instead of
 * pretending to have subscribed.
 */
export const readRuntimeEventSubscriber = (
  runtime: unknown,
): RuntimeEventSubscriber | undefined => {
  const subscribe = readRuntimeFunction(runtime, "subscribeEvents");
  if (!subscribe) return undefined;
  return (sink) => {
    const detach = (subscribe as (s: unknown) => unknown).call(runtime, sink);
    return typeof detach === "function" ? (detach as () => void) : () => undefined;
  };
};
