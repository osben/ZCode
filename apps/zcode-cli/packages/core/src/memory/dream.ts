import { mkdir, open, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelToolCall } from "@zcode/contracts";

import { analyzeBashCommand } from "../tool/handlers/bash-command-parser.js";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";

const DREAM_LOCK_FILE = ".consolidate-lock";
// Written only after a Dream run finishes without throwing. The lock's mtime marks a run START
// (it is taken over by in-progress and crashed attempts too), so only this marker's mtime can
// back a "last successful consolidation" display.
const DREAM_CONSOLIDATED_AT_FILE = ".consolidated-at";
const DREAM_LOCK_FRESH_MS = 60 * 60 * 1000;
/** Exclusive-create attempts before treating the lock as contended. */
const DREAM_LOCK_ACQUIRE_ATTEMPTS = 2;
const AUTO_DREAM_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000;

/** Stamp the memory root with the completion time of a successful Dream run. */
export async function writeDreamConsolidatedAt(memoryRoot: string): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, DREAM_CONSOLIDATED_AT_FILE), "", "utf8");
}

export type AutoDreamTimingDecision =
  | { decision: "scan" }
  | { decision: "skip"; reason: "minimum-interval" | "scan-throttled" };

export function evaluateAutoDreamTiming(input: {
  lastConsolidatedAtMs: number;
  lastScanAtMs: number;
  nowMs: number;
}): AutoDreamTimingDecision {
  if (input.nowMs - input.lastConsolidatedAtMs < AUTO_DREAM_MINIMUM_INTERVAL_MS) {
    return { decision: "skip", reason: "minimum-interval" };
  }
  if (input.nowMs - input.lastScanAtMs < AUTO_DREAM_SCAN_THROTTLE_MS) {
    return { decision: "skip", reason: "scan-throttled" };
  }
  return { decision: "scan" };
}

export async function readDreamLastConsolidatedAt(memoryRoot: string): Promise<number> {
  try {
    return (await stat(dreamLockPath(memoryRoot))).mtimeMs;
  } catch {
    return 0;
  }
}

export async function acquireDreamLock(input: {
  memoryRoot: string;
  nowMs?: number;
  pid?: number;
}): Promise<number | null> {
  const lockPath = dreamLockPath(input.memoryRoot);
  const nowMs = input.nowMs ?? Date.now();
  const pid = input.pid ?? process.pid;

  await mkdir(input.memoryRoot, { recursive: true });

  // Mutual exclusion must come from an exclusive create (O_CREAT|O_EXCL), NOT from writing a PID
  // and reading it back: two concurrent calls of one process write the same PID, so the read-back
  // cannot distinguish them and both callers would believe they own the lock.
  for (let attempt = 0; attempt < DREAM_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    const prior = await readDreamLockState(lockPath);
    if (prior && nowMs - prior.mtimeMs < DREAM_LOCK_FRESH_MS && isHeldLock(prior)) {
      return null;
    }
    if (prior) await unlink(lockPath).catch(() => {});

    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(pid), "utf8");
      } finally {
        await handle.close();
      }
      return prior?.mtimeMs ?? 0;
    } catch (error) {
      if (!isLockExistsError(error)) throw error;
      // Lost the exclusive-create race against a concurrent owner; re-read and decide again.
    }
  }
  return null;
}

export async function restoreDreamLockAfterFailure(input: {
  memoryRoot: string;
  priorMtimeMs: number;
  pid?: number;
}): Promise<void> {
  const lockPath = dreamLockPath(input.memoryRoot);
  const pid = input.pid ?? process.pid;
  // A failed run must not touch a lock that another run has taken over since — deleting it here
  // would tear down a live owner's lock and re-open the concurrent-consolidation window.
  if ((await readDreamLockState(lockPath))?.pid !== pid) return;
  if (input.priorMtimeMs === 0) {
    await unlink(lockPath);
    return;
  }
  // An empty PID reads as "owner mid-acquire" (held); a restored lock must read as
  // stale/abandoned so the next run can take it over. PID 0 is never a live process.
  await writeFile(lockPath, "0", "utf8");
  const priorSeconds = input.priorMtimeMs / 1000;
  await utimes(lockPath, priorSeconds, priorSeconds);
}

export function buildMemoryDreamPrompt(input: {
  memoryRoot: string;
  sessionIds: readonly string[];
  transcriptRoot: string;
}): string {
  const sessionLines = input.sessionIds.map((sessionId) => `- ${sessionId}`).join("\n");
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${input.memoryRoot}/\`
This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

Session transcripts: \`${input.transcriptRoot}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`MEMORY.md\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- \`ls -R logs/\` — recent activity logs (one file per session under \`YYYY/MM/DD/\`). If a \`sessions/\` subdirectory also exists, review recent entries there too

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Session logs** (\`logs/YYYY/MM/DD/<id>-<title>.md\`) — the append-only activity stream, one file per session. Read the most recent 1–3 days of sessions (the filename title tells you what each was about); each line is prefix-coded (\`>\` user, \`<\` assistant, \`.\` tool call)
2. **Existing memories that drifted** — facts that contradict something you see in the codebase now
3. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${input.transcriptRoot}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under 200 lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

### Reconcile memories against CLAUDE.md

Project CLAUDE.md instructions are loaded in your system prompt. For each \`feedback\` or \`project\` memory, check whether it contradicts a CLAUDE.md instruction on the same topic:

- **Memory is stale** — CLAUDE.md and the memory describe different procedures for the same task: CLAUDE.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **CLAUDE.md may be stale** — the memory is clearly dated after CLAUDE.md and explicitly corrects it: do NOT edit CLAUDE.md during a dream. Annotate the memory with "contradicts CLAUDE.md — verify which is current" and list it in your summary so the user can update CLAUDE.md.
- **Not a conflict** — the memory adds detail CLAUDE.md doesn't cover, or narrows a CLAUDE.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than CLAUDE.md — CLAUDE.md may have been updated since.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.

## Additional context



**Tool constraints for this run:** Shell access is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar) plus deleting \`.md\` paths inside the memory directory. Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${input.sessionIds.length}):
${sessionLines}`;
}

export function collectDreamTouchedPaths(
  paths: Set<string>,
  input: {
    rootDir: string;
    toolCall: ModelToolCall;
    workingDirectory: string;
    workspaceRoot: string;
  },
): void {
  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    const filePath = stringProperty(input.toolCall.input, "file_path");
    const resolved = filePath ? resolveTouchedPath(filePath, input) : undefined;
    if (resolved) paths.add(resolved);
    return;
  }
  if (input.toolCall.name !== "Bash") return;
  const command = stringProperty(input.toolCall.input, "command");
  if (!command) return;
  const analysis = analyzeBashCommand(command);
  for (const invocation of analysis.commands) {
    if (invocation.argv[0] !== "rm") continue;
    for (const argument of invocation.argv.slice(1)) {
      if (argument === "--" || argument.startsWith("-")) continue;
      const resolved = resolveTouchedPath(argument, input);
      if (resolved) paths.add(resolved);
    }
  }
}

function dreamLockPath(memoryRoot: string): string {
  return join(memoryRoot, DREAM_LOCK_FILE);
}

interface DreamLockState {
  mtimeMs: number;
  pid?: number;
}

/** Missing or unreadable lock reads as "no owner"; the exclusive create ultimately decides. */
async function readDreamLockState(lockPath: string): Promise<DreamLockState | undefined> {
  try {
    const [lockStat, content] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
    const parsedPid = Number.parseInt(content.trim(), 10);
    return Number.isFinite(parsedPid)
      ? { mtimeMs: lockStat.mtimeMs, pid: parsedPid }
      : { mtimeMs: lockStat.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * A fresh lock is held unless its owner PID is known to be gone. An empty or unparsable PID counts
 * as held, not stale: the file becomes visible at the exclusive create before its PID is written,
 * so "no PID yet" means a concurrent owner is mid-acquire, not an abandoned lock.
 */
function isHeldLock(state: DreamLockState): boolean {
  return state.pid === undefined || isLiveProcess(state.pid);
}

function isLockExistsError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

function isLiveProcess(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveTouchedPath(
  filePath: string,
  input: Pick<
    Parameters<typeof collectDreamTouchedPaths>[1],
    "rootDir" | "workingDirectory" | "workspaceRoot"
  >,
): string | undefined {
  if (!filePath.endsWith(".md")) return undefined;
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}
