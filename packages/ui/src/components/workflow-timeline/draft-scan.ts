import type { TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Streaming draft: while the model is still writing the script and the analyzer has not run, draw the **phase line** on the card—
 * stations and faint track segments only, with no pills, arcs, or status. Count subagents only (`N phases · M agents` in the header),
 * leaving the visualization to the analyzer. This is a **regex-level scanner**, not a parser: it recognizes only `phase("…")` and `agent("…")`.
 * False matches are harmless because the analyzer replaces the whole model once display arrives (invariant 10).
 *
 * A second `phase("implement")` with the same name revisits that station (the analyzer folds it into a back-edge), not a new station.
 * Draft scanning only adds stations, so its count matches the analyzer and no station disappears at handoff. A final unfinished `phase("ver` gives the last station
 * `typing`。
 */
export interface WorkflowDraftPhase {
  name: string;
  typing?: true;
}

export interface WorkflowDraft {
  phases: WorkflowDraftPhase[];
  /** Subagent names deduplicated in order of appearance (counted, not rendered). */
  agents: string[];
}

const TOKEN = /\b(phase|agent)\(\s*(?:(["'`])([^"'`\n]*)(\2)?)?/gu;

export function scanWorkflowDraft(script: string): WorkflowDraft {
  const phases: WorkflowDraftPhase[] = [];
  const agents: string[] = [];
  for (const match of script.matchAll(TOKEN)) {
    const [, kind, quote, body, closing] = match;
    if (quote === undefined) continue;
    // For template-literal interpolation, keep only the head: `Researcher${i}` becomes "Researcher"; a partial name is better than none.
    const name = (body ?? "").split("${")[0]!.trim();
    const closed = closing !== undefined;
    if (kind === "phase") {
      // A station already being typed is this marker itself: streaming may scan the same occurrence repeatedly, so finish its name rather than opening another station.
      const last = phases[phases.length - 1];
      if (last?.typing === true) {
        last.name = name;
        if (closed) delete last.typing;
        continue;
      }
      if (closed && phases.some((phase) => phase.name === name)) continue;
      phases.push({ name, ...(closed ? {} : { typing: true }) });
      continue;
    }
    if (!closed || name.length === 0) continue;
    if (!agents.includes(name)) agents.push(name);
  }
  return { agents, phases };
}

/** Draft → timeline model: stations and faint track segments only, with no pills, arcs, or status. */
export function draftTimeline(draft: WorkflowDraft): WorkflowTimelineModel {
  const stations: TimelineStation[] = draft.phases.map((phase, i) => ({
    id: `draft:${i}`,
    naming: { id: `draft:${i}`, name: phase.name },
    onLoop: false,
    pills: [],
    rounds: 0,
    status: undefined,
    track: 0,
    visited: false,
    ...(phase.typing === true ? { typing: true as const } : {}),
  }));
  return {
    arcs: [],
    bands: [],
    draft: { agents: draft.agents.length },
    live: false,
    rails: stations.slice(1).map((_, i) => ({ from: i, ink: "faint" as const, to: i + 1 })),
    runningIndex: undefined,
    stations,
  };
}
