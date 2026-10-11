// ============================================================
// Pure model for a script transcript.
// ============================================================
// One journal node row → material for one tool card: kind (Read / Search / Git / Terminal), main text, command line,
// stage and iteration, status label, and footer numbers. No React, DOM, or data fetching.
//
// Dispatch by **op**, not kind: `kind` only distinguishes world-read / world-run, while cards need the four verbs “read a file,”
// “find something,” “git,” and “run a command”—the divisions of the files / git / world facade containers.
// Historical rows from before this upgrade have no op (`input_json` is NULL); fall back to the step label in the static graph and use the generic kind “Step.”

import type { WorkflowRunState, WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";

export type WorkspaceCardKind = "read" | "search" | "git" | "terminal" | "step";

/** Static content for one card (no status—status lives in `workspaceCardStatus` because it also overlays the live projection). */
export interface WorkspaceCardModel {
  /** React key and ToolLayout toolId / expanded-state memory key. */
  key: string;
  node: WorkflowRunWorkspaceNode;
  kind: WorkspaceCardKind;
  op: string | undefined;
  /** Read: path; Search: pattern (glob / grep); Git: subcommand + args; Terminal: command line; Step: step label. */
  primary: string;
  /** Search’s second argument (grep glob scope); path for Git diff. */
  secondary?: string;
  /** Terminal: `cmd arg…` (the line after `$` in the expanded panel). */
  command?: string;
  /** Owning stage (looked up by station in the static graph); absent when the graph is unavailable or the station is not in it. */
  phase?: PhaseNaming;
  /** Invocation number for that station (journal sequence); the source chip shows ⟳n when > 1. */
  round: number;
}

interface WorkspaceCardStatus {
  status: WorkflowRunWorkspaceNode["status"];
  /** Live projection indicates that this step hit a cached resume result (`replayed` chip). */
  replayed: boolean;
}

function argString(args: readonly unknown[] | undefined, index: number): string | undefined {
  const value = args?.[index];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function argList(args: readonly unknown[] | undefined, index: number): string[] {
  const value = args?.[index];
  if (Array.isArray(value)) return value.map((item) => String(item));
  // In truncated mode, array arguments are already JSON preview text.
  if (typeof value === "string" && value.startsWith("[")) return [value];
  return [];
}

/** Display one argv item: quote arguments containing spaces, matching how they appear in a terminal command. */
export function formatCommandLine(cmd: string, args: readonly string[]): string {
  const quote = (part: string) => (/[\s"']/.test(part) ? JSON.stringify(part) : part);
  return [cmd, ...args].map(quote).join(" ");
}

export function workspaceCardKindOf(op: string | undefined): WorkspaceCardKind {
  if (op === undefined) return "step";
  if (op === "read") return "read";
  if (op === "glob" || op === "grep") return "search";
  if (op.startsWith("git-")) return "git";
  if (op === "run") return "terminal";
  return "step";
}

/** `git-changed-files` → `changed-files`; both the source chip and main text use this value. */
function gitSubcommand(op: string): string {
  return op.slice("git-".length);
}

/**
 * Lookup table from station to phase. Static-graph steps include `phase`; `source ?? id` is the station id (copies expanded from a may-set include `source`).
 * Scripts without a `phase()` marker have no phases, so the table is empty and cards have no source chip.
 */
function phaseBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, PhaseNaming> {
  const table = new Map<string, PhaseNaming>();
  if (graph === undefined) return table;
  const phases = new Map((graph.phases ?? []).map((phase) => [phase.id, phase] as const));
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    const phase = phases.get(step.phase);
    if (phase === undefined) continue;
    table.set(step.source ?? step.id, { id: phase.id, name: phase.name });
  }
  return table;
}

/** Static step label by station (fallback main text for historical rows). */
function stepLabelBySiteId(graph: WorkflowCausalityGraphData | undefined): Map<string, string> {
  const table = new Map<string, string>();
  for (const step of graph?.steps ?? []) table.set(step.source ?? step.id, step.label);
  return table;
}

export function buildWorkspaceCards(
  nodes: readonly WorkflowRunWorkspaceNode[],
  graph: WorkflowCausalityGraphData | undefined,
): WorkspaceCardModel[] {
  const phases = phaseBySiteId(graph);
  const labels = stepLabelBySiteId(graph);
  return nodes.map((node) => {
    const op = node.op;
    const kind = workspaceCardKindOf(op);
    const phase = phases.get(node.siteId);
    const base = {
      key: `${node.siteId}@${node.ordinal}`,
      node,
      kind,
      op,
      round: node.ordinal,
      ...(phase === undefined ? {} : { phase }),
    };
    const fallback = labels.get(node.siteId) ?? node.siteId;
    switch (kind) {
      case "read":
        return { ...base, primary: argString(node.args, 0) ?? fallback };
      case "search": {
        const scope = argString(node.args, 1);
        return {
          ...base,
          primary: argString(node.args, 0) ?? fallback,
          ...(scope === undefined ? {} : { secondary: scope }),
        };
      }
      case "git": {
        const sub = gitSubcommand(op!);
        const target = argString(node.args, 0);
        const shown = node.args?.map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        );
        return {
          ...base,
          primary: `git ${formatCommandLine(sub, shown ?? [])}`,
          ...(target === undefined ? {} : { secondary: target }),
        };
      }
      case "terminal": {
        const cmd = argString(node.args, 0) ?? fallback;
        const command = formatCommandLine(cmd, argList(node.args, 1));
        return { ...base, primary: command, command };
      }
      default:
        return { ...base, primary: fallback };
    }
  });
}

/**
 * Overlay for the live projection: add only `cached` (replayed chips). Journal rows are authoritative for state.
 * If the projection is settled while the journal still says running, the query is briefly stale and catches up when `lastEventSequence` advances.
 * Conversely, if the journal leads the projection (admission is persisted before the event is sent), the node is absent from the projection.
 */
export function workspaceCardStatus(
  node: WorkflowRunWorkspaceNode,
  run: WorkflowRunState | undefined,
): WorkspaceCardStatus {
  const live = run?.nodes.find(
    (candidate) => candidate.siteId === node.siteId && candidate.ordinal === node.ordinal,
  );
  return { status: node.status, replayed: live?.cached === true };
}

/** Target index: the first card in this phase; if the phase has not started (no card), return -1 to scroll the pane to the end. */
export function firstCardIndexOfPhase(
  cards: readonly WorkspaceCardModel[],
  phaseId: string,
): number {
  return cards.findIndex((card) => card.phase?.id === phaseId);
}

/** Format one step's duration as `1.3s` / `840ms` / `2m 05s`. */
export function formatWorkspaceDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Format the body size as `4.1 KB` / `312 B` / `1.2 MB`. */
export function formatWorkspaceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Status text for failed rows: show "timed out" for driver timeout codes and the code itself for other failures. */
export function isTimeoutError(error: { code: string; message: string } | undefined): boolean {
  if (error === undefined) return false;
  return /timeout|timed ?out/i.test(error.code) || /timed out|timeout/i.test(error.message);
}
