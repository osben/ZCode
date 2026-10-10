import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import {
  pillActivity,
  type TimelinePill,
  type WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineLamp,
  SpinePieces,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { spineSections } from "@/app-shell/workflowRunSpine.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The spine for the run detail page: the horizontal timeline on the card is read vertically here. A track runs down the left edge;
 * phases are lights on the track, and its ink deepens as control passes through, advancing along the active phase. Subagents are full-width pills
 * to the right of the light (the same pills as on the card); escalation questions are one level below the asker's row. **Do not draw back edges**:
 * those belong on the card, where the `⟳ n` in the phase header already says how many rounds this station ran.
 *
 * Rail segments, their ink, and light status all read the same `buildWorkflowTimeline` model (invariant 1: one model, three
 * consumers). Draw a rail segment only between adjacent stations with `rails` in the model—the same rule as the card; leave adjacent stations without an edge disconnected.
 *
 * Parallel phases (a model **band**) appear as indentation here: branch rails curve away from the main rail above the first station in the band,
 * descend one station at a time, then return at the top of the merge station. Branch station headers and pills shift right by 12px while the main rail continues past them.
 * `workflowRunSpine.ts` calculates which vertical rails and curves each station needs; this component only lays them out. **Do not draw back edges** (as above).
 *
 * A collapsed phase header shows an avatar strip (up to 3 + `+n`): collapsing must not hide who is at the station.
 * Active phases expand automatically: open **every** running station (two rails in a band can run at the same time) and leave already-open stations as they are.
 *
 * Stations over the participant threshold become a roster (design notes: "Phase roster," "a gate and a list"): pin 5 pills (asking → running →
 * failed → replacement), and use the sixth slot for a gate (collapsed with a count of the remaining participants). Behind the gate is a roster of everyone else—once each,
 * grouped by status, as two-column `row` pills; replace the collapsed header's avatar strip with a mini meter. Subagents beyond the visible limit (`station.unlisted`) count
 * toward the gate, count row, and meter but have no row of their own, so add a muted line at the end of the roster to explain the difference.
 *
 * Landing: the "n more" row on the card or a phase header passes the station id to the host, and the tab arrives with
 * `focusPhaseId`—expand the station, open its gate, scroll its header to the top, and briefly highlight its background. Land once per open
 * (the key includes openedAt, so opening the same station again lands again); do not follow the user after they scroll away.
 */
const QUESTION_TICK_MS = 30_000;
/** Landing highlight duration: hold for 400 ms, then fade over 800 ms (`.wf-landed`). */
const LANDING_MS = 1200;

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`;
}

const pillKey = pillInstanceKey;

export const WorkflowRunPhaseList = memo(function WorkflowRunPhaseList({
  graph,
  landing,
  model,
  onOpenActor,
  onOpenWorkspace,
  pendingQuestions,
  run,
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** Open an actor transcript tab (show a placeholder for a slot without a session). If absent, the row is not clickable; the callback's presence is the gate. */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** Open a script transcript tab and land on this station; if absent, the script row is not clickable. */
  onOpenWorkspace?: (phaseId: string) => void;
  /** Landing request: `key` is unique for every open (`phaseId@openedAt`), so opening the same station again lands again. */
  landing?: { phaseId: string; key: string };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // Running stations expand automatically—a band can have two rails running at once, so open **every** one, not only the rightmost.
  // Use a stable key for this set of ids: the projection creates a new model identity after each update, but the set usually stays the same.
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const runningIds = useMemo(
    () => (runningKey === "" ? [] : runningKey.split("\u0000")),
    [runningKey],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(runningIds));
  useEffect(() => {
    setOpen((previous) =>
      runningIds.every((id) => previous.has(id)) ? previous : new Set([...previous, ...runningIds]),
    );
  }, [runningIds]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Gate for a roster station: opening it lists participants. This is local list state, tracked per station.
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Landing: expand + open the gate + highlight; scroll after the next commit (the section must expand before its header can be scrolled into view).
  // Track `landed` by landing key, not station: landing on the same station again changes the key and repeats scroll/highlight.
  const rootRef = useRef<HTMLDivElement>(null);
  const landedOnceRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<{ phaseId: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (landing === undefined || landedOnceRef.current === landing.key) return undefined;
    landedOnceRef.current = landing.key;
    const { phaseId } = landing;
    setOpen((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setListed((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setLanded(landing);
    const timer = setTimeout(
      () => setLanded((current) => (current?.key === landing.key ? undefined : current)),
      LANDING_MS,
    );
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => {
    if (landed === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const section = [...root.querySelectorAll<HTMLElement>("[data-phase-id]")].find(
      (candidate) => candidate.getAttribute("data-phase-id") === landed.phaseId,
    );
    const head = section?.querySelector<HTMLElement>('[data-testid="workflow-run-phase-toggle"]');
    if (head === undefined || head === null || typeof head.scrollIntoView !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [landed]);

  // Waiting duration must update on its own: a run waiting for an answer **emits no events**. Create the timer only while a question exists.
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions = pendingQuestions.length > 0;
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);

  const questionsByInstance = useMemo(() => {
    const byKey = new Map<string, WorkflowRunPendingQuestion[]>();
    for (const question of pendingQuestions) {
      const key = questionKey(question);
      if (key === undefined) continue;
      const list = byKey.get(key) ?? [];
      list.push(question);
      byKey.set(key, list);
    }
    return byKey;
  }, [pendingQuestions]);
  const attachedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const station of model.stations) {
      for (const pill of station.pills) {
        const key = pillKey(pill);
        if (key !== undefined) keys.add(key);
      }
    }
    return keys;
  }, [model]);
  const orphanQuestions = pendingQuestions.filter((question) => {
    const key = questionKey(question);
    return key === undefined || !attachedKeys.has(key);
  });
  // Vertical rails and curves for each station (`workflowRunSpine.ts`): look up rail segments by **pair**, not by from—one station in a band
  // may be the left endpoint of both a branch rail and a main rail.
  const sections = spineSections(model);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // The row supplies slot identity: use its session id when present, otherwise open a placeholder tab.
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** Shared pill wiring (name, status, open action), used by full-width rows and compact pills in "show all." */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // Same open behavior as a script row: open the run's script transcript and land on the first card for this station.
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: label,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // Clickable pills are <button>s; inside a block parent they wrap only their content, so row widths vary with name length.
    // A vertical flex container makes each row fill the column width (the same mechanism as the pill column under a phase on the card).
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          {counts.length === 0 ? null : (
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {counts.join(" · ")}
            </span>
          )}
        </WorkflowAgentPill>
        {/* Place the question 26 px below its asker; it belongs to that row, not the phase. */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      className="wf-motion flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
    >
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const spine = sections[index] ?? { curves: [], rails: [] };
        // Shift the whole branch station one step right: header, pills, and light together, leaving 12px between rails.
        const indent = station.track === 0 ? undefined : { paddingLeft: 39 + 12 * station.track };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        return (
          <section
            className="relative"
            data-phase-id={station.id}
            data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
            data-phase-open={expanded ? "true" : "false"}
            data-phase-status={status}
            data-phase-track={station.track}
            data-testid="workflow-run-phase"
            key={station.id}
          >
            <SpinePieces section={spine} />
            <button
              aria-expanded={expanded}
              aria-label={intl.formatMessage(
                {
                  id: expanded
                    ? "chat.toolCall.workflow.run.phase.collapse"
                    : "chat.toolCall.workflow.run.phase.expand",
                },
                { name },
              )}
              className={cn(
                "wf-station-open relative flex h-9 w-full items-center gap-2 pl-[39px] pr-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
                landed?.phaseId === station.id && "wf-landed",
              )}
              data-testid="workflow-run-phase-toggle"
              // Change the key and remount the header on a new landing; the same class name alone would not restart the CSS animation.
              key={landed?.phaseId === station.id ? landed.key : "head"}
              onClick={() => toggle(station.id)}
              style={indent}
              type="button"
            >
              <SpineLamp status={status} track={station.track} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-ui-base",
                  pending ? "text-foreground-subtle" : "font-medium text-foreground",
                )}
              >
                {name}
              </span>
              <span className="flex shrink-0 items-center gap-2.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                {expanded ? null : roster !== undefined ? (
                  <RosterMeter counts={roster.counts} mini />
                ) : (
                  <AvatarCluster nameOf={nameOf} pills={station.pills} />
                )}
                {station.fraction === undefined ? null : (
                  <span data-testid="workflow-run-phase-fraction">
                    {station.fraction.settled}/{station.fraction.observed}
                  </span>
                )}
                <Rounds station={station} />
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                />
              </span>
            </button>
            {expanded ? (
              <div
                className="wf-unfold flex flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5"
                style={indent}
              >
                {roster === undefined ? (
                  station.pills.map(renderPill)
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5" data-testid="workflow-roster-pins">
                      {roster.pinned.map(renderPill)}
                    </div>
                    <WorkflowMoreRow
                      door={{
                        open: listed.has(station.id),
                        tally: rosterRestCounts(roster),
                      }}
                      more={rosterMore(roster)}
                      onOpen={() => toggleListed(station.id)}
                    />
                    {listed.has(station.id) ? (
                      <WorkflowRoll
                        groups={rosterRoll(roster)}
                        unlisted={roster.unlisted.actors}
                        renderRow={(pill, enterDelayMs) => (
                          <WorkflowAgentPill
                            enterDelayMs={enterDelayMs}
                            key={pill.key}
                            size="row"
                            {...pillProps(pill)}
                          >
                            {/* Askers from the sixth onward appear in the list: show a ? before the trailing slot, without repeating the question itself here. */}
                            {pill.asking === true ? (
                              <CircleHelpIcon
                                aria-hidden
                                className="size-3 shrink-0 text-warning"
                                data-testid="workflow-roll-asking"
                              />
                            ) : null}
                          </WorkflowAgentPill>
                        )}
                      />
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
        >
          <span className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.questions.title" })}
          </span>
          {orphanQuestions.map((question) => (
            <WorkflowRunQuestionRow key={question.qid} now={now} question={question} showAsker />
          ))}
        </div>
      )}
    </div>
  );
});
