# Nested AGENTS.md discovery

Status: draft for implementation
Scope: `apps/zcode-cli/packages/core` (tool executor, runtime wiring, system reminder registry)

## 1. Problem

The workspace instruction loader (`apps/zcode-cli/packages/adapters/src/context/index.ts`) walks from the session cwd upward
to the project root (`findInstructionFile`). It returns the first priority file it finds (`DEFAULT_PRIORITY_FILES = ["AGENTS.md"]`).
It never looks **down** into subfolders. A `packages/foo/AGENTS.md` is therefore invisible when the session starts at the repo root,
even when the agent spends the whole session editing `packages/foo`.

Nested discovery did not exist before this change. Confirmed by grep of `core/src`, `adapters/src`, `contracts/src`: the only
`userInstructions` consumers are the startup snapshot, the `# agentsMd` section builder, and subagent inheritance.

## 2. Product rules

R1. **Trigger.** A successful tool call that touches a path inside the workspace may make the agent enter a folder that owns an
instruction file. Tools and the path they contribute:

| Tool (canonical name)   | Input field(s)                                                              | Directory checked                                                                     |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Read`, `Edit`, `Write` | `file_path`                                                                 | `dirname(file_path)`                                                                  |
| `ApplyPatch`            | handler output `files[].filePath` / `movePath` (the files actually written) | `dirname` of each path                                                                |
| `Glob`, `Grep`          | `path` (optional)                                                           | `path` if it is a directory, else `dirname(path)`; when omitted, the live session cwd |
| `Bash`                  | none (no cwd input exists)                                                  | the live session cwd **after** the call, so `cd sub && ...` is covered                |

Paths are resolved against the call's working directory when relative. Bash command text is not parsed in v1.
Other tools (LSP, MCP, workflow tools) do not trigger discovery.

R2. **Scope.** For each triggered directory `D`, every directory from `D` up to the workspace root, **excluding** the workspace root and
anything above it, is a candidate. Candidate file names are the loader's priority files (`AGENTS.md` by default). Within one
directory the first existing priority file wins, the same rule the upward walk uses. The workspace root and everything above it are
owned by the startup loader and are never walked here.

R3. **Ignored paths.** A triggered path outside `workspaceRoot` (lexical containment check) produces no candidates, and an
explicit `Glob` / `Grep` path outside it is rejected before any stat. A path equal to the workspace root produces none.
A candidate is checked by its folder before any I/O: a `priorityFiles` entry containing `..` that leaves the workspace, or
resolves to a file in the workspace root, is never stat'ed.
A candidate that is already one of the startup `userInstructions.sources[].filePath` values is never re-injected.

R4. **Delivery.** A found file is delivered inside the **same tool result** that triggered it, as a `<system-reminder>` block
(source `nested_agents_md`). This is an append to the tool result's model content. It does not touch the system prompt, the
prompt prefix, `context_prefix`, or the cache-stable request prefix. Delivery goes through the existing hook-context append path
(`appendHookAdditionalContexts` in `call-runner.ts`), so result-budget truncation, persisted-artifact previews and the CUA
structured-content path all keep working.

R5. **Once per session context.** A file is delivered at most once per provider-visible context. "Provider-visible" is what the
model currently sees (see R7).

R6. **Budget.**

- Per file: 16 KiB (`16384` bytes) of file content injected. Longer files are cut at a UTF-8 code-point boundary and marked:
  `[truncated: showing first 16384 of N bytes]`.
- Per context: 64 KiB (`65536` bytes) total of injected nested content currently visible in history.
- When the total would be exceeded, deeper candidates are kept and broader ones are dropped first. Within one tool call the
  candidates are considered deepest first and the selected ones are emitted root-to-leaf.
- A dropped candidate is not recorded anywhere. It can be delivered by a later call when budget frees up (after compaction or
  microcompaction).

R7. **Dedupe source of truth = provider-visible history.** A nested file counts as delivered when either:

- a visible tool result contains a reminder marker for it (`[nested-agents-md path=<json-string> bytes=<n>]`), or
- a visible successful `Read` of that exact file was a full read (no `offset` / `limit`) and its result still carries the
  numbered body. A fresh-cache `file_unchanged` stub or a cleared result does not count. A relative `file_path` resolves against
  the live cwd before keying. This matches the `agent/loaded-skills.ts` precedent. Compaction, microcompaction (`runtime/methods/microcompact.ts` clears
  old tool-result bodies), resume and rewind therefore need no extra synchronization. When the model no longer sees the content,
  the file can be delivered again.

  **Known limitation (v1):** a relative `Read` is keyed against the cwd at the time of the history read, not the cwd when the
  call ran. If the model reads `packages/foo/AGENTS.md` and then `cd`s, the same file can be delivered once more. The cost is one
  extra copy inside the context budget; no instruction is lost. Recording the call-time path on the tool-call record would fix it,
  but that changes the history format used by resume and compaction, so it is deferred.

R8. **Subagents.** Each runtime, including a subagent child, has its own history and therefore its own delivered set. A child does
not inherit the parent's delivered set, because the child's model never saw the parent's reminders. The child uses the same
trigger and budget rules. Its startup root exclusions come from its own snapshot plus `subagentContext.userInstructions.sources`.

R9. **Incognito.** Disabled when `incognitoExcludes(config.incognito, "projectInstructions")` holds, the same gate the startup
loader uses. No new setting is added. The state is never written to `setting.json`.

R10. **Remote workspaces.** All stat and read calls go through the executing tool's `fileSystemPort` (the same port Read/Edit use),
so the read happens on the host that runs the tool. Core never imports `node:fs`.

R11. **Failure is non-fatal.** Any discovery error (stat, read, parse) is logged at `debug` and skipped. The tool result is returned
unchanged. Discovery is never allowed to fail or delay a tool call beyond its own IO. Cancellation via the call's abort signal
skips discovery.

R12. **Authority.** The reminder text frames the content as scoped project instructions: they apply to files under that folder,
they are more specific than the workspace instructions, and they do not override system, developer or direct user instructions.
This mirrors the wording used by the DeepSeek harness (`render.ts`). Nested files are repository content, so the same
data-not-authority framing applies.

R13. **Logging.** `deps.logger?.debug` only, with event names `instructions.nested.discovered` and `instructions.nested.skipped`.
No content is logged; only relative directories and counts. CLI core has no `createServiceLogger` path
(`grep -rn createServiceLogger apps/zcode-cli` returns nothing), so the executor's existing logger is used. No `info` logs.

R14. **Paths.** Dedupe and containment keys use `normalizeToolPathForComparison(path, platform)`.

- win32: keys are case-folded, and `/c/...` Git-Bash drive aliases are normalized by that helper.
- darwin: keys are case-folded too (the default APFS volume is case-insensitive). Reads use the caller's spelling, which stat resolves
  on a case-insensitive volume.
- linux: keys are case-sensitive.
  Containment compares the same folded keys: `relative()` from `getToolPathApi(platform)` runs on
  `nestedInstructionKey(root)` and `nestedInstructionKey(path)`, so on darwin `/Repo/packages/foo` is inside `/repo`. The
  folder depth used for ordering is computed from the same keys.

Known limit: symlinks are checked lexically. A symlinked folder inside the workspace that points outside it is treated as inside.
This matches the existing path policy, which does not hard-block outside paths.

## 3. State owners

| State                              | Owner                                                                                            | Lifetime                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Delivered set and budget           | Provider-visible history (`messageHistory.borrowReadOnlyRuntimeEntries()`), read through a probe | Exactly as long as the history entries                                         |
| Schedule reservations and bytes    | `NestedInstructionTracker`, one per runtime (keys plus injected bytes of this schedule)          | Cleared by `settleToolResults` after the step's results are committed (see §4) |
| Stat miss cache                    | `NestedInstructionTracker`                                                                       | 30 s TTL per candidate path, so an AGENTS.md created mid-session is found soon |
| Workspace root and startup sources | Runtime (`workspaceRoot`, `contextSourceSnapshot`)                                               | Session                                                                        |

No component keeps a second accepted "delivered" set. The tracker holds only transient reservations and a miss cache.

## 4. Event order

```text
Model step emits tool calls
  │
  ▼
runtime.executeTools ─► executor.executeSchedule(calls)   ── tracker: reservations begin empty
  │
  ├─ call A (Read a/x.ts)  ─ handler ok ─ serialize ─ PostToolUse hooks
  │     │
  │     ▼  call-runner: resolve touched locations (sync, pure)
  │     ▼  discover(A), phase 1 (no history read), folders stat'ed in parallel:
  │     │   per folder, first existing priority file:
  │     │     root / touched-file ──► folder decided, skip
  │     │     miss-cache ──► next name
  │     │     stat(file) ── missing ──► cache miss, next name
  │     │   no file found ──► return (transcript never scanned)
  │     │   discover(A), phase 2 (history read here), deepest first:
  │     │     history.delivered has key ──► skip
  │     │     estimate (history bytes + reserved bytes) ── cannot fit ──► skip, file not read
  │     │     readTextFile(maxBytes) ── fail ──► debug, skip
  │     │     reserve(key, bytes, 64 KiB − history bytes) SYNC: duplicate key ──► skip;
  │     │       bytes + reserved bytes > budget ──► skip; else reserve key and bytes (no await until push)
  │     ▼  append <system-reminder> to modelContent ──► result A
  │
  ├─ call B (Read a/y.ts)  ── runs concurrently with A
  │     discover(B): may stat/read a/AGENTS.md too, but reserve() fails ──► skip (no duplicate)
  │
  ▼  call A's schedule finishes; call C (streamed, same step) starts ── reserve() still holds a/AGENTS.md ──► skip
  │
  ▼  settleToolResults: commitTurnRequestEntries (markers now visible), then tracker.clearReservations()
  │
  ▼  next model step: probe sees markers, so a later call in a/ skips
  │
  ▼  microcompact / compaction removes the result ──► markers gone ──► re-deliverable
```

Why reservations end at settlement, not at the end of an `executeTools` call: the streaming coordinator runs one
`executeTools([call])` per streamed tool while the model is still responding, and their results enter history only at
`settleToolResults` (`runtime/methods/tool-result-settlement.ts`). Clearing when one call ends would let a later streamed call
in the same step see neither the reservation nor the marker, and deliver the same file twice. The clear runs right after the
synchronous commit, so no window opens between them. Skipped candidates are never reserved, so nothing has to be released on
error paths.

## 5. Interfaces

Core, new module `apps/zcode-cli/packages/core/src/context/nested-instructions/`:

```ts
// touched-paths.ts (pure)
export interface NestedInstructionLocation {
  path: string; // absolute
  kind: "file" | "directory" | "unknown"; // unknown: stat decides (Glob/Grep path)
}
export function resolveNestedInstructionTargets(input: {
  toolName: string;
  toolInput: unknown;
  toolOutput?: unknown; // ApplyPatch: files the handler reported
  workingDirectory: string; // live session cwd; relative paths resolve against it, and Bash uses it directly
  platform: NodeJS.Platform;
}): { locations: NestedInstructionLocation[]; touchedFiles: string[] };

// history.ts (pure)
export interface NestedInstructionHistory {
  delivered: ReadonlySet<string>; // normalized keys
  bytesDelivered: number;
}
export function readNestedInstructionHistory(
  entries: readonly RuntimeMessageEntry[],
  platform: NodeJS.Platform,
): NestedInstructionHistory;

// tracker.ts
export class NestedInstructionTracker {
  reserve(
    key: string,
    bytes: number,
    availableBytes: number,
  ): "reserved" | "duplicate" | "over_budget";
  // synchronous check-and-add of key and bytes; availableBytes = budget left after history; reserved bytes are subtracted here
  reservedBytes: number; // bytes reserved by this schedule and not yet in history; used only for the pre-read estimate
  clearReservations(): void; // called by settleToolResults after the step's results are committed to history
  isKnownMiss(key: string, now: number): boolean;
  recordMiss(key: string, now: number): void; // TTL 30 s; expired entries swept once the cache is large
}

// discover.ts
export interface NestedInstructionContext {
  priorityFiles: readonly string[];
  rootSourcePaths: readonly string[];
  readHistory(): NestedInstructionHistory; // lazy: called only after a candidate file exists
  tracker: NestedInstructionTracker; // owned by the runtime
}
export interface NestedInstructionDiscoveryInput extends NestedInstructionContext {
  locations: readonly NestedInstructionLocation[];
  touchedFiles: readonly string[];
  workspaceRoot: string;
  platform: NodeJS.Platform;
  fileSystem: FileSystemPort;
  signal?: AbortSignal;
  now: number;
  logger?: Logger;
}
export const NESTED_INSTRUCTION_MAX_FILE_BYTES = 16 * 1024;
export const NESTED_INSTRUCTION_MAX_CONTEXT_BYTES = 64 * 1024;
export const NESTED_INSTRUCTION_MISS_TTL_MS = 30_000;
// Lines for wrapSystemReminderForSource, or undefined when nothing is delivered.
export function discoverNestedInstructions(
  input: NestedInstructionDiscoveryInput,
): Promise<string[] | undefined>;
```

Executor wiring, `tool/executor/types.ts`: `ToolExecutorOptions` / `ToolExecutorDeps` gain
`nestedInstructions?: NestedInstructionContext` (re-exported from `discover.ts`). The runtime
(`runtime/helpers/nested-instructions-context.ts`) returns `undefined` under incognito, so absent means the executor is unchanged.

Serialization, `tool/executor/result-serialization.ts`: the hook-context projection is factored into
`appendFormattedContextToSerialization(serialization, formattedContext, entry)`. `appendHookAdditionalContexts` keeps its current
behavior and calls it. The nested reminder uses the same function.

System reminder registry, `system-reminder/source.ts`: new source `nested_agents_md`, channel `tool_result`, lifecycle
`tool_result`, `isMeta: true`, provider-visible. It is listed next to `tool_result_warning` in
`SYSTEM_REMINDER_PERSISTED_SOURCES` and `NON_MID_CONVERSATION_SYSTEM_SOURCES`, because it is never a standalone user message. It
is wrapped with `wrapSystemReminderForSource`, which escapes nested tags. The raw `wrapSystemReminder` would throw on an AGENTS.md
that contains a `<system-reminder>` tag.

Reminder body format:

```text
<system-reminder>
[nested-agents-md path="/abs/repo/packages/foo/AGENTS.md" bytes=1234]
Nested AGENTS.md instructions apply to the folders this tool call touched. Each applies to files under its own folder ...
Instructions from: packages/foo/AGENTS.md
<content>
</system-reminder>
```

All marker lines come first, then the intro, then each file's `Instructions from:` line and content, root-to-leaf. The history
probe reads only the marker lines at the head of each `<system-reminder>\n` block: a line-by-line match of
`/^\[nested-agents-md path=("(?:[^"\\\n]|\\.)*") bytes=(\d+)\]$/`, stopping at the first line that is not a marker. The
repository-controlled body is never parsed, so AGENTS.md text cannot fake a delivered path or inflate `bytesDelivered`. `path` is a
JSON string. Marker-shaped text outside a reminder block does not count.

Runtime wiring: `runtime/agent-runtime.ts` constructs one `NestedInstructionTracker`, and `runtime/helpers/nested-instructions-context.ts`
builds the `NestedInstructionContext`. `readHistory` calls `readNestedInstructionHistory(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), platform, runtime.workingDirectory)`,
so the cwd is read at call time.
`rootSourcePaths` comes from `contextSourceSnapshot.userInstructions.sources` plus `subagentContext.userInstructions.sources`.
`priorityFiles` comes from `config.userInstructions?.priorityFiles`, defaulting to `["AGENTS.md"]`.

## 6. Acceptance scenarios

A1. Session cwd is the repo root. `packages/foo/AGENTS.md` exists. `Read packages/foo/src/a.ts` succeeds. Its result ends with one
`nested_agents_md` reminder containing that file. The system prompt is unchanged.

A2. Same session. `Edit packages/foo/src/a.ts` succeeds. No second reminder for `packages/foo/AGENTS.md` appears in this context.

A3. A root-level `AGENTS.md` (workspace root) is never re-injected by any tool call.

A4. The session started in `packages/foo`, and that folder has `AGENTS.md`. The startup loader already loaded it. Later calls under
`packages/foo/src` deliver nothing for it.

A5. `Read /outside/repo/x.ts`, or a `Write` path outside `workspaceRoot`, delivers nothing and performs no stat.

A6. Two parallel `Read`s in `packages/foo/` in one schedule deliver `packages/foo/AGENTS.md` exactly once.

A7. A file over 16 KiB is cut at a code-point boundary and marked truncated. A context whose visible nested bytes already total
64 KiB delivers nothing new. Within one call, with room for only one of two candidates, the deeper file is kept.

A8. A successful full `Read packages/foo/AGENTS.md` earlier in history means the same file is not injected again.

A9. After compaction or microcompaction removes the tool result that carried the reminder, the next touch of that folder
delivers it again.

A10. Read of a missing directory, a stat error, or a read error returns the tool's original result with a debug log.

A11. Incognito with `projectInstructions` excluded: no discovery, no stat, identical results to today.

A12. Subagent child: its first touch of `packages/foo` delivers the file even if the parent already delivered it.

A13. Windows: `C:\repo\packages\foo\src\a.ts` with root `c:\repo`, and `/c/repo/packages/foo/AGENTS.md` alias, resolve to one key.
Git-Bash `/c/...` tool paths are converted to drive paths before containment, so they are not rejected as outside the workspace.
Covered by the unit tests on `resolveNestedInstructionPath` and `normalizeToolPathForComparison` plus containment.

A14. Two streamed calls in one model step deliver `packages/foo/AGENTS.md` once, even when the first call's schedule has ended
before the second starts and the step has not yet settled.

## 7. Cost

- A call whose touched folders have no nested instruction file costs only stats (cached misses for 30 s). It never scans the transcript.
- A call that finds a nested file scans the visible history once. The scan is linear in the visible transcript. This is accepted
  for v1; if it shows up in profiles, cache the probe result per history revision.

## 8. Open questions and deliberate gaps

- Bash command text is not parsed. `cat packages/foo/x.ts` alone does not trigger discovery. Only the live cwd does.
- A candidate file that the model reads with a `Read` range (`offset` / `limit`) is not counted as delivered. It is injected once more.
- The reminder probe trusts any text that contains a `<system-reminder>` line followed by marker lines. A repository file that the
  model reads (`Read`, or `Bash` output such as `cat`) can contain that text and fake a delivered path. The effect is suppression of
  one nested file, not injection. Closing this needs the probe to ignore non-reminder tool output, which is a separate change.
- Resume and rewind rebuild history from persisted events, so the markers come back with the transcript. This was not verified
  end to end for resumed sessions and needs a test if rewind is in scope.
- Symlink escape is not checked (see R14).
- `Glob` / `Grep` without `path` use the live cwd only, not each result's folder.
