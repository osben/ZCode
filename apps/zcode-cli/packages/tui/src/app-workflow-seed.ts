// Mirror replay, seeding, and interrupted notices on cold start / session recovery.
//
// Three rules:
//   1. Runtime state comes **only** from replay: `replayWorkflowRuns` yields progress envelopes of the same kind as live events,
//      ordered by journal sequence and fed one by one to the shared reducer. Replaying real events in order does not move phases backward
//      (the prohibition is against "synthesizing out-of-order events from summaries" and still applies: summaries seed display names only).
//   2. Seeding carries display names only: label / updatedAt. Do not invent status or infer resumable (a status bit carried by the reducer).
//   3. There is no second clock: query once on mount and once when the app changes; do not poll or use setInterval.
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiListWorkflowRuns, TuiReplayWorkflowRuns, TuiWorkflowRunSummary } from "./types.js";
import type { TuiWorkflowRunSeed } from "./app-workflow-mirror.js";

/** Convert a summary to a seed entry. Copy only display facts from the server and preserve missing values (do not invent a label). */
export function workflowRunSeedFromSummary(summary: TuiWorkflowRunSummary): TuiWorkflowRunSeed {
  return {
    runId: summary.runId,
    ...(summary.label === undefined ? {} : { label: summary.label }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
  };
}

/** Notice text for one run. Fall back to runId when label is missing; a list with one fewer label is degraded, not erroneous. */
export function workflowInterruptedNoticeText(seed: TuiWorkflowRunSeed, copy: TuiCopy): string {
  return copy.transcript.workflow.interruptedNotice({
    label: seed.label ?? seed.runId,
    runId: seed.runId,
  });
}

/**
 * Append notice lines for resumable runs to the transcript. Emit nothing when there are no runs (the spec's Excludes).
 *
 * Use a system line instead of fabricating a user line; this is not something the user said.
 */
export function appendWorkflowInterruptedNotices(
  messages: Message[],
  seeds: readonly TuiWorkflowRunSeed[],
  copy: TuiCopy,
): Message[] {
  if (seeds.length === 0) return messages;
  return [
    ...messages,
    ...seeds.map((seed) => ({
      content: workflowInterruptedNoticeText(seed, copy),
      role: "system" as const,
    })),
  ];
}

/**
 * Runs to announce after startup / `/resume`: those the server marks `resumable`.
 *
 * **Intentionally do not sort**: `updatedAt` is display-only, and the port comment explicitly forbids the read side from reordering by it.
 * Sorting belongs to storage (most recently updated first); sorting again on the read side could drift from the server's tie-break.
 */
export function interruptedWorkflowNotices(
  summaries: readonly TuiWorkflowRunSummary[],
): readonly TuiWorkflowRunSeed[] {
  return summaries.filter((summary) => summary.resumable === true).map(workflowRunSeedFromSummary);
}

/**
 * Replay first, then seed once on mount.
 *
 * The order matters: replay first so cards show real step counts immediately; seeding then adds names only. Failure of both queries must not
 * prevent the TUI from starting; live events can still render in-flight runs.
 *
 * Call callbacks indirectly through refs, and depend only on the identities of the two query functions: the input object is new on each render,
 * and depending on it directly would rerun this effect's queries on every render (creating a second clock).
 */
export function useWorkflowRunSeeding(input: {
  copy: TuiCopy;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  /** Runs already in the mirror (those this process has received events for); replay excludes them. */
  knownRunIds: () => ReadonlySet<string>;
  replay: (envelopes: readonly WorkflowRunProgressEnvelope[]) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): void {
  const latest = React.useRef(input);
  latest.current = input;
  const { listWorkflowRuns, replayWorkflowRuns } = input;

  React.useEffect(() => {
    if (!listWorkflowRuns && !replayWorkflowRuns) return;
    let cancelled = false;
    void (async () => {
      if (replayWorkflowRuns) {
        try {
          const envelopes = await replayWorkflowRuns({
            excludeRunIds: latest.current.knownRunIds(),
          });
          if (cancelled) return;
          if (envelopes.length > 0) latest.current.replay(envelopes);
        } catch {
          // A replay failure must not prevent the TUI from starting.
        }
      }
      if (!listWorkflowRuns) return;
      let summaries: readonly TuiWorkflowRunSummary[];
      try {
        summaries = await listWorkflowRuns();
      } catch {
        return;
      }
      if (cancelled || summaries.length === 0) return;
      latest.current.seed(summaries.map(workflowRunSeedFromSummary));
      // Preserve server order (most recently updated first); the port comment forbids read-side reordering.
      const resumable = interruptedWorkflowNotices(summaries);
      if (resumable.length === 0) return;
      latest.current.setMessages((current) =>
        appendWorkflowInterruptedNotices(current, resumable, latest.current.copy),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [listWorkflowRuns, replayWorkflowRuns]);
}
