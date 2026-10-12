// ============================================================
// The hole branches of the workflowRuns reduction: `hole-reached` / `hole-filled`, plus hole indexes on the phase table
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate, same precedent as phases / started).
// Contract: the "The model" section of "Holes on the timeline" in
// docs/dynamic-workflow/presentation.md, and "Holes" in
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunHole,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { boundedPhaseName, nonEmptyString } from "./workflow-runs-entries.js";

/**
 * Hole site id: `hole#` plus 8 hex digits; the key is the hole's **name**, independent of nesting
 * depth (minted by the CLI's analysis/hole-id.ts; see "Sites" in
 * apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md).
 * The id no longer encodes nesting: which hole contains a hole is read from the `fill` on its own
 * phase / site.
 */
export const WORKFLOW_HOLE_SITE_ID_PATTERN = /^hole#[0-9a-f]{8}$/u;

function readEpoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Carrying over `run-launched.holes` / `hole-filled.holes`: the indexes point at the **accepted**
 * `phaseNames`, so out-of-range, non-integer, and duplicate values are all dropped — an
 * out-of-range index would make the sidebar draw a dashed marker on a nonexistent site. Returns
 * `undefined` when nothing remains: the key is not created.
 */
export function readPhaseHoles(raw: unknown, count: number): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value >= count || out.includes(value)) continue;
    out.push(value);
    if (out.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return out.length === 0 ? undefined : out;
}

/**
 * The declared phase table on the payload (same shape for `run-launched` and `hole-filled`): in
 * declaration order, trimmed to the same bounds as `phases`.
 * An empty table returns `undefined`, and the caller leaves the existing table untouched.
 */
export function readPhaseNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    names.push(name);
    if (names.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return names.length === 0 ? undefined : names;
}

/**
 * `hole-reached`: the run walks into an open hole and that branch parks. Upsert by **site id** —
 * in a loop the same site parks a second ordinal, and the table keeps only the newest; replaying
 * the same event is byte-for-byte unchanged (the top-level structural diff returns null
 * immediately). `name` is the entire reason this record exists (every surface labels it by name);
 * absence only raises the watermark. The limit behaves like nodes / actors: reject new entries,
 * keep updating existing ones, set truncated.
 */
/** Prompt truncated to the limit: when too long, keep 499 characters plus `…` so the total stays 500. */
function boundedHolePrompt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const max = WORKFLOW_RUNS_LIMITS.maxHolePromptLength;
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

export function reduceHoleReached(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const instance = payload.instance;
  if (typeof instance !== "object" || instance === null) return run;
  const siteId = nonEmptyString((instance as Record<string, unknown>).siteId);
  const ordinalRaw = (instance as Record<string, unknown>).ordinal;
  const ordinal = typeof ordinalRaw === "number" && Number.isInteger(ordinalRaw) ? ordinalRaw : 0;
  const name = boundedPhaseName(nonEmptyString(payload.name));
  if (siteId === undefined || name === undefined) return run;
  const type = nonEmptyString(payload.type)?.slice(0, WORKFLOW_RUNS_LIMITS.maxHoleTypeLength);
  const prompt = boundedHolePrompt(nonEmptyString(payload.prompt));
  // The reached time can only come from the event (this module has no clock); both key names are
  // accepted: `reachedAt` is the notification payload's word, `since` the projection's.
  const since = readEpoch(payload.reachedAt) ?? readEpoch(payload.since);
  const entry: WorkflowRunHole = {
    siteId,
    ordinal,
    name,
    ...(type === undefined ? {} : { type }),
    ...(prompt === undefined ? {} : { prompt }),
    state: "waiting",
    ...(since === undefined ? {} : { since }),
  };
  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // Existing record (including one that was filled and then reached again — that is a resume
    // replaying to a not-yet-filled site): switch back to waiting, reusing the recorded type when
    // the new one is absent.
    const previous = existing[index]!;
    const merged: WorkflowRunHole = {
      ...entry,
      ...(entry.type === undefined && previous.type !== undefined ? { type: previous.type } : {}),
      ...(entry.prompt === undefined && previous.prompt !== undefined
        ? { prompt: previous.prompt }
        : {}),
    };
    return { ...run, holes: existing.map((hole, i) => (i === index ? merged : hole)) };
  }
  if (existing.length >= WORKFLOW_RUNS_LIMITS.maxHoles) return { ...run, truncated: true };
  return { ...run, holes: [...existing, entry] };
}

/**
 * `hole-filled`: the main agent's fill is wired into the run. Three things happen in one step —
 * the record flips to filled, the phase table is replaced with the post-fill declared table
 * (a superset: the hole's body expands in place at the hole's position), and the hole index table
 * is replaced wholesale. The "running alongside" table shifts right by the insertion position:
 * the fill inserts k phases after the hole's site, so every old index > h shifts by +k; if the
 * table shape does not match (not this kind of insertion), drop it — better for the sidebar to
 * draw fewer parallel segments than to connect them to the wrong site.
 */
export function reduceHoleFilled(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const siteId = nonEmptyString(payload.siteId);
  if (siteId === undefined) return run;
  const filledAt = readEpoch(payload.filledAt);
  const filledBy = nonEmptyString(payload.filledBy)?.slice(0, 128);
  let next: WorkflowRunState = run;

  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // The prompt exists only for the waiting body: drop it after filling; the settled run state
    // does not carry it.
    const { prompt: _prompt, ...reached } = existing[index]!;
    void _prompt;
    const filled: WorkflowRunHole = {
      ...reached,
      state: "filled",
      ...(filledAt === undefined ? {} : { filledAt }),
      ...(filledBy === undefined ? {} : { filledBy }),
    };
    next = { ...next, holes: existing.map((hole, i) => (i === index ? filled : hole)) };
  }

  const phaseNames = readPhaseNames(payload.phaseNames);
  if (phaseNames === undefined) return next;
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  const phaseAlongside = shiftPhaseAlongside(run, phaseNames);
  const { phaseAlongside: _stale, phaseHoles: _staleHoles, ...rest } = next;
  void [_stale, _staleHoles];
  return {
    ...rest,
    phaseNames,
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/** Old table + "insert k phases after the hole's position" → "running alongside" indexes on the new table; returns undefined when the shape does not match. */
function shiftPhaseAlongside(
  run: WorkflowRunState,
  names: readonly string[],
): number[][] | undefined {
  const old = run.phaseNames;
  const alongside = run.phaseAlongside;
  if (old === undefined || alongside === undefined) return undefined;
  const inserted = names.length - old.length;
  if (inserted < 0) return undefined;
  // Find the insertion point h: prefix old[0..h] and suffix old[h+1..] both match verbatim.
  let h = -1;
  for (let i = 0; i < old.length; i += 1) {
    if (old[i] !== names[i]) break;
    h = i;
  }
  if (h < 0) return undefined;
  for (let i = h + 1; i < old.length; i += 1) {
    if (old[i] !== names[i + inserted]) return undefined;
  }
  const shift = (i: number): number => (i <= h ? i : i + inserted);
  const out: number[][] = [];
  for (let i = 0; i < names.length; i += 1) {
    const source = i <= h ? i : i - inserted;
    const entry = i > h && i <= h + inserted ? [] : (alongside[source] ?? []);
    out.push(entry.map(shift));
  }
  return out.some((entry) => entry.length > 0) ? out : undefined;
}

/**
 * Strip waiting records (new generation / terminal state): the truth is the in-process parked
 * deferred, same rationale as pendingQuestions — nobody is waiting for a fill in a stopped run;
 * a resume replaying to that site emits a fresh `hole-reached`. filled records survive across
 * generations: that is code wired into the run, not a ghost. When none remain, drop the whole key.
 */
export function withoutWaitingHoles(run: WorkflowRunState): WorkflowRunState {
  if (run.holes === undefined) return run;
  const kept = run.holes.filter((hole) => hole.state === "filled");
  if (kept.length === run.holes.length) return run;
  const { holes: _dropped, ...rest } = run;
  void _dropped;
  return kept.length === 0 ? rest : { ...rest, holes: kept };
}
