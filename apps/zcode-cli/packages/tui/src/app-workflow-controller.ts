// TUI controller for the DWF runtime mirror (following the same hook convention as useSidebarController / useInputHistory).
//
// Owns only state and derived values: the mirror, card join map, and expanded set. Session event wiring stays in app.tsx
// (the subscription needs applySessionEvent, which in turn needs this hook's setters; putting both here would create a cycle).
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiOptions } from "./types.js";
import { useWorkflowRunSeeding } from "./app-workflow-seed.js";
import {
  EMPTY_TUI_WORKFLOW_MIRROR,
  applyWorkflowProgressToMirror,
  buildTuiWorkflowCardIndex,
  type TuiWorkflowCard,
  type TuiWorkflowMirror,
  seedWorkflowMirror,
  type TuiWorkflowRunSeed,
} from "./app-workflow-mirror.js";

/** Expand/collapse controls for `+`/`-`, grouped in one object so app.tsx passes only one additional prop. */
export type TuiWorkflowExpansionControls = {
  /** Consume `+`/`-` only when at least one card exists; otherwise those keys must be inserted into the draft as usual. */
  hasCards: boolean;
  expandAll: () => void;
  collapseAll: () => void;
};

type TuiWorkflowRunsController = {
  mirror: TuiWorkflowMirror;
  setMirror: React.Dispatch<React.SetStateAction<TuiWorkflowMirror>>;
  cardsByToolCallId: ReadonlyMap<string, TuiWorkflowCard>;
  expandedRunIds: ReadonlySet<string>;
  toggleExpansion: (runId: string) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  expansion: TuiWorkflowExpansionControls;
};

export function useTuiWorkflowRuns(input: {
  copy: TuiCopy;
  options: TuiOptions;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): TuiWorkflowRunsController {
  const [mirror, setMirror] = React.useState<TuiWorkflowMirror>(EMPTY_TUI_WORKFLOW_MIRROR);
  const [expandedRunIds, setExpandedRunIds] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const cardsByToolCallId = React.useMemo(() => buildTuiWorkflowCardIndex(mirror), [mirror]);

  const toggleExpansion = React.useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  // Cold seeding carries display names only (label / updatedAt). Runtime state comes from the replay below: the journal's **real, ordered** events
  // are reduced through the same reducer. The rule "never synthesize events from summaries and feed them to the reducer" applies to out-of-order synthesis,
  // not to engine events replayed by sequence.
  const seed = React.useCallback((seeds: readonly TuiWorkflowRunSeed[]) => {
    setMirror((current) => seedWorkflowMirror(current, seeds));
  }, []);
  const replay = React.useCallback((envelopes: readonly WorkflowRunProgressEnvelope[]) => {
    setMirror((current) => envelopes.reduce(applyWorkflowProgressToMirror, current));
  }, []);
  const mirrorRef = React.useRef(mirror);
  mirrorRef.current = mirror;
  const knownRunIds = React.useCallback(
    () => new Set(mirrorRef.current.state.runs.map((run) => run.runId)),
    [],
  );

  // Expand/collapse all: the TUI intentionally has no card selection mechanism (no panel or cursor), so `+`/`-` can apply only to all cards.
  const runIdsKey = [...cardsByToolCallId.values()].map((card) => card.runId).join("\u0000");
  const expandAll = React.useCallback(() => {
    setExpandedRunIds(new Set(runIdsKey.length === 0 ? [] : runIdsKey.split("\u0000")));
  }, [runIdsKey]);
  const collapseAll = React.useCallback(() => setExpandedRunIds(new Set<string>()), []);

  // Seed once on mount and add interrupted notices; do not poll (a second clock is the cautionary example of the legacy panel).
  useWorkflowRunSeeding({
    copy: input.copy,
    ...(input.options.listWorkflowRuns === undefined
      ? {}
      : { listWorkflowRuns: input.options.listWorkflowRuns }),
    ...(input.options.replayWorkflowRuns === undefined
      ? {}
      : { replayWorkflowRuns: input.options.replayWorkflowRuns }),
    knownRunIds,
    replay,
    seed,
    setMessages: input.setMessages,
  });

  return {
    mirror,
    setMirror,
    cardsByToolCallId,
    expandedRunIds,
    toggleExpansion,
    seed,
    expansion: { hasCards: cardsByToolCallId.size > 0, expandAll, collapseAll },
  };
}
