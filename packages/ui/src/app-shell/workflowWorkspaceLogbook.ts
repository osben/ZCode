// ============================================================
// Logbook presentation for the script transcript: organize cards into chapters (phases), with a time ruler and command-output tails.
// No React, DOM, or data fetching.
// ============================================================
// Chapters follow **execution order**: consecutive cards in the same phase form one chapter; re-entering a phase starts a new chapter with round +1 —
// matching ⟳n in the side-pane spine (number of entries), not the number of times an individual node was called.

import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import type { WorkspaceCardModel } from "@/app-shell/workflowWorkspaceTranscript.js";

export interface WorkspaceChapter {
  key: string;
  /** Cards without a phase because the graph is unavailable (or the node is not in it) have no chapter header. */
  phase: PhaseNaming | undefined;
  /** Which entry this is for the phase; if > 1, the chapter header includes ⟳n. */
  round: number;
  cards: WorkspaceCardModel[];
  startedAt: number;
  endedAt: number;
}

export function buildWorkspaceChapters(cards: readonly WorkspaceCardModel[]): WorkspaceChapter[] {
  const chapters: WorkspaceChapter[] = [];
  const entries = new Map<string, number>();
  for (const card of cards) {
    const last = chapters.at(-1);
    const phaseId = card.phase?.id;
    if (last !== undefined && last.phase?.id === phaseId) {
      last.cards.push(card);
      last.startedAt = Math.min(last.startedAt, card.node.createdAt);
      last.endedAt = Math.max(last.endedAt, card.node.updatedAt);
      continue;
    }
    const round = phaseId === undefined ? 1 : (entries.get(phaseId) ?? 0) + 1;
    if (phaseId !== undefined) entries.set(phaseId, round);
    chapters.push({
      key: `${phaseId ?? "-"}#${chapters.length}`,
      phase: card.phase,
      round,
      cards: [card],
      startedAt: card.node.createdAt,
      endedAt: card.node.updatedAt,
    });
  }
  return chapters;
}

/** Time-ruler origin: admission time of the first card (the run's own start time is not in the list). */
export function transcriptOrigin(cards: readonly WorkspaceCardModel[]): number | undefined {
  let origin: number | undefined;
  for (const card of cards) {
    if (origin === undefined || card.node.createdAt < origin) origin = card.node.createdAt;
  }
  return origin;
}

/** `+0:00` / `+1:12` / `+1:02:05`: a card's time relative to the origin. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `+${mmss}`;
}

/** `6s` / `2m 05s`: “started ago” duration for a running card. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface TranscriptSummary {
  phases: number;
  steps: number;
  /** From the first card's admission to the last card's settlement (or `now` if it is still running). */
  durationMs: number;
}

export function transcriptSummary(
  cards: readonly WorkspaceCardModel[],
  now: number,
): TranscriptSummary {
  const phases = new Set<string>();
  let start: number | undefined;
  let end = 0;
  let running = false;
  for (const card of cards) {
    if (card.phase !== undefined) phases.add(card.phase.id);
    if (start === undefined || card.node.createdAt < start) start = card.node.createdAt;
    end = Math.max(end, card.node.updatedAt);
    if (card.node.status === "running") running = true;
  }
  const durationMs = start === undefined ? 0 : Math.max(0, (running ? now : end) - start);
  return { phases: phases.size, steps: cards.length, durationMs };
}

interface PeekLine {
  text: string;
  /** Looks like a one-line error (× / ✗ / FAIL / Error…); use destructive color in the peek. */
  error: boolean;
}

function isErrorLine(line: string): boolean {
  const trimmed = line.trim();
  return /^([×✗✖]|x\s|FAIL\b|ERR(OR)?\b|Error\b|error:)/i.test(trimmed) || /Error:/.test(trimmed);
}

/** Tail of command output: last non-empty stdout lines, or stderr if stdout is empty; same for string bodies; otherwise there is no peek. */
export function peekLinesOf(result: unknown, max = 3): PeekLine[] {
  let text: string | undefined;
  if (typeof result === "string") text = result;
  else if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const fields = result as Record<string, unknown>;
    const stdout = typeof fields.stdout === "string" ? fields.stdout : "";
    const stderr = typeof fields.stderr === "string" ? fields.stderr : "";
    text = stdout.trim().length > 0 ? stdout : stderr;
  }
  if (text === undefined) return [];
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-max).map((line) => ({ text: line, error: isErrorLine(line) }));
}

// Remember expanded state per card (same module-level map approach as ToolLayout): collapse/re-expand and tab switching preserve it.
const openState = new Map<string, boolean>();

export function rememberedOpen(key: string): boolean {
  return openState.get(key) ?? false;
}

export function setRememberedOpen(key: string, open: boolean): void {
  openState.set(key, open);
}
