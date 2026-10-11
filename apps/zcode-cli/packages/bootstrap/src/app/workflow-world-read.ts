// ============================================================
// Execution side of world reads (Boundary B's executeWorldRead).
// ============================================================
// One half extracted from workflow-driver.ts. The driver handles actor sessions, turn
// orchestration, and submit bridging; this module turns an (op, args) pair into a real read-only
// observation. Their only contact point is {@link executeWorldRead}; this half never touches
// sessions, models, or the journal.
//
// Three responsibilities live here and only here:
//   1. **Per-op arity and argument validation.** Boundary A's `worldRead(siteId, op, args)` only
//      promises positional pass-through (lowering does not inspect op), so this side defines
//      what a pattern or base ref looks like.
//   2. **Enforcing limits.** Constants live in the pure package (`@zcode/dynamic-workflow`'s
//      WORLD_READ_CAPS), but enforcement lives here because only this side can avoid producing
//      excess output: stopping ripgrep at 2,000 matches is better than materializing a million
//      and measuring afterward.
//   3. **Fixed git argv.** Construction is in workflow-git-world-read.ts (pure); spawning is here.

import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@zcode/dynamic-workflow";
import {
  GIT_SHOW_PREFIX_ARGV,
  GIT_STATUS_ARGV,
  gitChangedFilesPlan,
  gitDiffArgv,
  gitLogArgv,
  parseGitLog,
  parseGitPathList,
  parseGitShowPrefix,
  parseGitStatusPorcelainV2,
  type GitCommitResult,
  type GitStatusResult,
} from "./workflow-git-world-read.js";

/** Ports and base directory needed for world reads (a subset of driver deps). */
export interface WorldReadDeps {
  /** Filesystem port used by files.glob / files.read / files.grep. */
  readonly fileSystemPort: FileSystemPort;
  /** Child-process execution port for git.* (cwd = workspace root). */
  readonly executionPort: ExecutionPort;
  /** Base directory for path resolution and relativization (workspace root). */
  readonly cwd: string;
}

/**
 * Read arguments from the **positional argument array** according to op, then execute one world
 * read. Boundary A only promises positional pass-through (lowering does not inspect op), so
 * each op's arity and types are validated here; this is the layer that knows what a pattern or
 * base ref looks like.
 * Reject any shape mismatch for the node with a structured `DriverError`; never coerce silently.
 * A path silently converted from `undefined` to `"undefined"` with `String(undefined)` would
 * produce an opaque read failure instead of an actionable error.
 *
 * The `async` declaration is intentional: argument-validation errors must become a **rejection
 * of that node's promise**. A synchronous throw would escape `engine.worldRead` (the engine
 * attaches `.then(...)` only after journaling admission), leaving a node stuck in running.
 */
export async function executeWorldRead(
  deps: WorldReadDeps,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  switch (op) {
    case "glob":
      return await worldGlob(deps, worldReadStringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await worldRead(deps, worldReadStringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = worldReadOptionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await worldGrep(deps, pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = worldReadOptionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(deps, base);
    }
    case "git-diff": {
      const [base, path] = worldReadOptionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(deps, base, path);
    }
    case "git-status": {
      // No-argument op: empty `names` means exactly zero arguments; extra arguments still fail loudly.
      worldReadStringArgs(op, args, []);
      return await gitStatus(deps);
    }
    case "git-log":
      return await gitLog(deps, worldReadOptionalCount(op, args, "count"));
    case "run":
      return await worldRun(deps, args);
    default: {
      // The op vocabulary is derived from the world-read registry; a new entry not wired here
      // fails loudly in this branch.
      const unknownOp: never = op;
      throw new WorkflowError("DriverError", `Unsupported world-read op "${String(unknownOp)}".`);
    }
  }
}

/**
 * `files.glob(pattern)`: use FileSystemPort searchFiles and normalize to the facade's promised shape.
 *
 * The three normalization steps address differences between port semantics and the facade
 * contract; the port result cannot be returned unchanged.
 * The port is designed for the UI's Glob tool: absolute paths, mtime descending, and a default
 * limit of 100 entries.
 *
 * - **Reject at cap+1** (same pattern as worldGrep): the port's default truncation once applied
 *   silently, so a glob over 5,000 files returned only 2%, and the incomplete view entered the
 *   journal and replayed on resume. WORLD_READ_CAPS owns the cap; exactly cap results cannot
 *   distinguish a complete result from truncation, so request one extra.
 * - **Make paths workspace-relative**: absolute paths break script routing based on workspace-
 *   relative prefixes such as `startsWith("apps/…")`, silently collapsing a six-way fan-out into
 *   one path. grep/git already relativize; glob was the exception.
 * - **Sort lexicographically**: mtime changes on every write, but journaled values must be
 *   deterministic; repeated submissions of the same script should not fan out in a different
 *   order. Reject semantics ensure the result is complete before sorting.
 */
async function worldGlob(deps: WorldReadDeps, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const result = await deps.fileSystemPort.searchFiles({
    path: deps.cwd,
    pattern,
    maxResults: cap + 1,
  });
  if (result.files.length > cap || result.truncated) {
    throw capExceeded(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return result.files.map((path) => toWorkspaceRelative(deps.cwd, path)).sort();
}

/**
 * `files.read(path)`: resolve to an absolute path, then **confirm it is still within the
 * workspace** before passing it to the port.
 *
 * Why add this check now: before `git.*` landed, paths reaching this method were literals
 * written by the script, so leaving the workspace was explicit. `git.*` is the first primitive
 * that can **produce** paths: `changedFiles() → files.read(p)` is the obvious two-line use, and
 * native git output can include a `../` prefix when the workspace is a repository subdirectory.
 * The git side already uses pathspecs to constrain its scope to the workspace. This check
 * enforces the same invariant at the other end; an obvious composition of primitives should
 * not be a trap.
 */
async function worldRead(deps: WorldReadDeps, arg: string): Promise<string> {
  const path = assertWithinWorkspace("read", deps.cwd, arg);
  const result = await deps.fileSystemPort.readTextFile({ path });
  return result.content;
}

/**
 * `files.grep(pattern, glob?)`: use FileSystemPort searchText (ripgrep semantics).
 *
 * **Set headLimit to cap + 1**; this is the only non-obvious line in this method. The limit
 * means "reject if matches exceed cap," while the port only truncates at headLimit. Requesting
 * exactly cap would be ambiguous: cap matches could mean either exactly cap (allow) or that a
 * million later matches were truncated (reject). One extra match removes the ambiguity: cap+1
 * proves overflow at the cost of one record, without materializing the full result set.
 * `truncated` provides a second check; if the port truncates for another reason, the result is
 * incomplete.
 */
async function worldGrep(
  deps: WorldReadDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const result = await deps.fileSystemPort.searchText({
    path: deps.cwd,
    pattern,
    ...(glob === undefined ? {} : { glob }),
    outputMode: "content",
    showLineNumbers: true,
    headLimit: cap + 1,
  });
  if (result.entries.length > cap || result.truncated) {
    throw capExceeded(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const entry of result.entries) {
    // In content mode, every match includes a line number and line text. An entry missing either
    // is not a content match (for example, a count emitted by the port in another outputMode);
    // skip it instead of filling in 0 / "" to fabricate a match.
    if (entry.lineNumber === undefined || entry.text === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(deps.cwd, entry.path),
      line: entry.lineNumber,
      text: entry.text,
    });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw capExceeded(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

// ——————————————————————————————— Internal: git.* world reads ———————————————————————————————

/**
 * Run a git command and return stdout. argv is **constructed** by workflow-git-world-read.ts
 * (a fixed array, never a shell string); this method only passes it to the port and normalizes
 * failures into node-level `DriverError`s.
 *
 * The caller supplies `maxInlineBytes`: git.diff uses it for limit detection (same cap+1
 * approach as grep), while other ops use a sufficiently large default.
 */
async function runGit(
  deps: WorldReadDeps,
  op: WorldReadOp,
  argv: readonly string[],
  maxInlineBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: "git", args: [...argv] },
    cwd: deps.cwd,
    outputLimit: { maxInlineBytes },
  });
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    // Missing git, non-repositories, and invalid refs all reach this branch. Normalize them as
    // **catchable** DriverErrors instead of run-level failures so the script can fall back to
    // files.glob in a try/catch.
    const detail = firstLine(result.stderr.text) || firstLine(result.stdout.text) || result.status;
    throw new WorkflowError(
      "DriverError",
      `git ${argv.join(" ")} failed (${result.status}, exit=${result.exitCode ?? "n/a"}): ${detail}`,
    );
  }
  return {
    text: result.stdout.text,
    bytes: result.stdout.bytes,
    truncated: result.stdout.truncated,
  };
}

/**
 * Prefix from the workspace to the repository root (empty when the workspace is the repo
 * root). Paths on the wire are always repository-relative; strip this prefix to get the
 * workspace-relative paths promised by the facade (see output contract 2 at the top of
 * workflow-git-world-read.ts).
 *
 * Query on every read rather than caching: `rev-parse` takes milliseconds, and world reads run
 * only once per site×ordinal and are journaled, so this is not a hot path. In return, this side
 * remains completely stateless.
 */
async function gitWorkspacePrefix(deps: WorldReadDeps, op: WorldReadOp): Promise<string> {
  const out = await runGit(deps, op, GIT_SHOW_PREFIX_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitShowPrefix(out.text);
}

async function gitChangedFiles(deps: WorldReadDeps, base: string | undefined): Promise<string[]> {
  // Construct argv first: reject an invalid base **before running any git command**.
  const plans = gitChangedFilesPlan(base);
  const prefix = await gitWorkspacePrefix(deps, "git-changed-files");
  const paths: string[] = [];
  for (const plan of plans) {
    const out = await runGit(deps, "git-changed-files", plan.argv, GIT_TEXT_OUTPUT_BYTES);
    paths.push(...parseGitPathList(out.text, prefix));
  }
  // Deduplicate and sort the union: both commands may return the same path, and this value is
  // journaled, so it must depend only on the content and not on which command returns first.
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function gitDiff(
  deps: WorldReadDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  // cap + 1, for the same reason as grep: distinguish "exactly cap bytes" from "truncated."
  const out = await runGit(deps, "git-diff", gitDiffArgv(base, path), cap + 1);
  if (out.bytes > cap || out.truncated) {
    throw capExceeded(
      `git.diff: output is ${out.bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return out.text;
}

async function gitStatus(deps: WorldReadDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps, "git-status");
  const out = await runGit(deps, "git-status", GIT_STATUS_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitStatusPorcelainV2(out.text, prefix);
}

async function gitLog(deps: WorldReadDeps, count: number): Promise<GitCommitResult[]> {
  const out = await runGit(deps, "git-log", gitLogArgv(count), GIT_TEXT_OUTPUT_BYTES);
  return parseGitLog(out.text);
}

// ——————————————————————————————— Internal: world.run ———————————————————————————————

/** Return value for `world.run`. The authoritative declaration is `declare interface WorldRunResult` in FACADE_DTS. */
interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `world.run(cmd, args?, opts?)`: execute a journaled command.
 *
 * Three intentional differences from `git.*`, each part of the contract:
 *   1. **Nonzero exit is a value.** The execution adapter maps a nonzero exit to
 *      `status:"failed"` with `error` absent (statusFromExit/statusFailure in
 *      node-execution-adapter-results.ts), reliably distinguishing it from spawn failure or
 *      timeout. The normal gated-loop path should not use exception control flow.
 *   2. **No runtime command allowlist.** Authorization happens only at compile time: cmd must be
 *      a literal (9003), so every command the script can run is readable before submission and
 *      the confirmation graph shows them one by one. A launch-time `declaredRunCommands` set
 *      collected from the seed script was once rechecked here ("guarding only against wiring
 *      errors")-but hole-filling (FillWorkflowHole) compiles the effective script while the
 *      driver still held the seed's set, so a command appearing for the first time in a function
 *      body was rejected as a "wiring error." Lowering runs the script's own text, and the
 *      filled-in code is the effective script's own lowering, so that recheck guarded against
 *      nothing real while adding a second data source that had to be synced manually; it was
 *      removed.
 *   3. **No timeout ceiling.** Defaults to 300s; scripts can increase it as needed (for tests
 *      that really run for a long time). Cancellation remains the final control.
 *
 * stdout/stderr are each capped at 256 KB, probed at cap+1 (`maxInlineBytes` is one more than
 * the larger cap, then each stream is checked separately). Reject over-limit output rather than
 * truncating it; the message gives an actionable next step, following the same policy as grep/diff.
 */
async function worldRun(deps: WorldReadDeps, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = worldRunArgs(args);

  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: cmd, args: argv },
    cwd: deps.cwd,
    timeoutMs,
    outputLimit: { maxInlineBytes: Math.max(stdoutCap, stderrCap) + 1 },
  });

  if (result.status === "timed_out") {
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the work.`,
    );
  }
  // completed (exit 0) and failed-without-error (nonzero exit) are both **completed
  // observations**, so return their values. Other outcomes (spawn_error / cancelled / failed
  // with error, such as output_limit) mean the observation itself did not complete.
  const ranToExit =
    result.status === "completed" ||
    (result.status === "failed" &&
      result.error === undefined &&
      typeof result.exitCode === "number");
  if (!ranToExit) {
    const detail = result.error?.message ?? (firstLine(result.stderr.text) || result.status);
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' did not run to completion (${result.status}): ${detail}`,
    );
  }

  if (result.stdout.bytes > stdoutCap || result.stdout.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stdout is ${result.stdout.bytes} bytes, over the ${stdoutCap}-byte cap. ` +
        `Quiet the output (e.g. --quiet), or write a file and files.read a summary.`,
    );
  }
  if (result.stderr.bytes > stderrCap || result.stderr.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stderr is ${result.stderr.bytes} bytes, over the ${stderrCap}-byte cap. ` +
        `Reduce the diagnostics, or write a file and files.read a summary.`,
    );
  }

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * `world.run` argument shape: `[cmd: string, args?: string[], opts?: { timeoutMs?: number }]`.
 * Follows the same rules as {@link worldReadStringArgs} (fail loudly, never coerce), but the
 * shape (array + options bag) exceeds the string-sequence helper's scope, so it is separate.
 */
function worldRunArgs(args: unknown[]): { cmd: string; argv: string[]; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw new WorkflowError(
      "DriverError",
      `world.run takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireStringArg("run", args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: argument 2 (args) must be an array of strings, got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw new WorkflowError(
          "DriverError",
          `world.run: args[${index}] must be a string, got ${describeArg(item)}. Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  let timeoutMs: number = WORLD_READ_CAPS.runDefaultTimeoutMs;
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: arg 3 (opts) must be an options object or omitted, got ${describeArg(rawOpts)}.`,
      );
    }
    const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
    if (rawTimeout !== undefined) {
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
        throw new WorkflowError(
          "DriverError",
          `world.run: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
        );
      }
      // Intentionally do not cap the timeout: this supports tests that really run for a long
      // time; cancellation is the final control.
      timeoutMs = rawTimeout;
    }
  }

  return { argv, cmd, timeoutMs };
}

// ——————————————————————————————— Pure helpers ———————————————————————————————

/**
 * Extract the **required string arguments** described by `names` from the positional world-read
 * argument array. A shape mismatch throws a structured `DriverError` (node-level failure that
 * the script can `catch`). Validate exact arity against `names.length`: extra arguments can
 * only come from a wiring error because the facade's type signature rejects them at compile
 * time. If they appear at runtime, lowering or the wire protocol is broken; silently ignoring
 * them would hide a diagnosable bug as an ambiguous read.
 *
 * Why validate instead of coercing: Boundary A's `args: unknown[]` are the script arguments
 * passed through **unchanged**. This is the first and only layer that knows each op's arity.
 * `String(args[0])` turns `undefined` into the path `"undefined"`, so the resulting ENOENT
 * cannot identify the real mistake.
 *
 * Multi-argument ops with optional arguments (`files.grep(pattern, glob?)`, `git.diff(base?,
 * path?)`) use {@link worldReadOptionalStringArgs}, which permits missing trailing arguments;
 * the distinction is implemented in these two helpers, not at call sites.
 */
function worldReadStringArgs(op: WorldReadOp, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireStringArg(op, args[index], name, index));
}

/**
 * **Trailing-optional** variant of {@link worldReadStringArgs}: `required` is the required
 * prefix and `optional` is the optional suffix. Return an array of fixed length
 * `required.length + optional.length`, with absent optional positions set to `undefined`.
 *
 * Three rules, all part of failing loudly:
 *   1. Fewer than the required arguments or more than the total → structured `DriverError`.
 *      Extra arguments are still rejected for the same reason as in the exact-arity variant:
 *      the facade signature rejects them at compile time, so their presence at runtime can only
 *      mean lowering or the wire protocol is miswired. Silently ignoring them would hide a
 *      diagnosable bug as an ambiguous read.
 *   2. Required positions must be strings.
 *   3. **Optional positions may explicitly be `undefined`**, since scripts can write that value:
 *      `git.diff(undefined, "a.ts")` is valid for `base?: string`. Lowering packs arguments by
 *      position unchanged, so the driver really does receive an `undefined` prefix. Treating it
 *      as absent is the only sensible interpretation.
 *
 * Note that lowering packs omitted **trailing** arguments into a **shorter array** (not an
 * undefined hole), and `inputHash({op, args})` is the journal key. Thus `["TODO"]` and
 * `["TODO", "*.ts"]` are naturally different keys. This function normalizes both arrival
 * shapes to one call shape without rewriting args.
 */
function worldReadOptionalStringArgs(
  op: WorldReadOp,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((n) => `${n}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = [];
  required.forEach((name, index) => out.push(requireStringArg(op, args[index], name, index)));
  optional.forEach((name, offset) => {
    const index = required.length + offset;
    if (index >= args.length) {
      out.push(undefined);
      return;
    }
    const value = args[index];
    if (value === undefined) {
      out.push(undefined);
      return;
    }
    out.push(requireStringArg(op, value, name, index));
  });
  return out;
}

/**
 * Arguments for `git.log(count?)`: zero or one, must be a positive integer no greater than the
 * limit. If absent, use
 * {@link WORLD_READ_CAPS.gitLogDefaultCount}。
 *
 * **Reject** values above the limit instead of silently clamping them: if a script asks for 500
 * entries but gets 100, its own logic sees an opaque "why is the history so short?" error. An
 * error naming the limit lets the script fix the request directly.
 */
function worldReadOptionalCount(op: WorldReadOp, args: unknown[], name: string): number {
  const max = WORLD_READ_CAPS.gitLogMaxCount;
  if (args.length > 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes at most 1 argument (${name}?), got ${args.length}.`,
    );
  }
  const raw = args[0];
  if (raw === undefined) return WORLD_READ_CAPS.gitLogDefaultCount;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** Read a positional argument that must be a string, otherwise return a structured rejection
 * (never coerce with `String(...)`). */
function requireStringArg(op: WorldReadOp, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * Structured rejection for exceeding a limit. Every message includes an **actionable next step**
 * ("narrow the pattern or add a glob"): scripts can use the limit to adjust themselves, and
 * an error that only says "too much" wastes that opportunity.
 */
function capExceeded(message: string): WorkflowError {
  return new WorkflowError("WorldReadCapExceeded", message);
}

/**
 * Resolve a script-supplied relative path to an absolute path and determine **lexically** whether
 * it remains within the workspace; return `undefined` if it escapes (the caller chooses the
 * error wording and structured code—world reads report `DriverError`, artifact publishing reports
 * `ArtifactPathOutsideWorkspace`）。
 *
 * Use `relative(cwd, resolved)` as the test: its output is already normalized, and `..` can
 * appear only at the beginning, so "does not start with a `..` segment and is not absolute" is
 * equivalent to "still inside the workspace." The second condition is necessary on Windows,
 * where `relative` returns an absolute path rather than a sequence of `..` across drive letters.
 *
 * **Only perform lexical checks; do not follow symlinks**: a workspace symlink pointing outside
 * still passes this layer. World reads accept this known boundary (the script sees the bytes as
 * read); artifact publishing does not, because it **copies bytes into a persistent store for the
 * user**. That path performs an additional realpath check on top of this function (see
 * workflow-artifact-publish.ts).
 *
 * **The export is intentional**: the definition of escaping the workspace must have one
 * implementation. If it is duplicated, the two copies may eventually disagree on a path, and
 * one of them is a security boundary.
 */
export function resolveWithinWorkspace(cwd: string, arg: string): string | undefined {
  const resolved = resolvePath(cwd, arg);
  const rel = relativePath(cwd, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolutePath(rel) ? undefined : resolved;
}

/** World-read wrapper around {@link resolveWithinWorkspace}: escaping the workspace returns a
 * structured `DriverError` (catchable by the script). */
function assertWithinWorkspace(op: string, cwd: string, arg: string): string {
  const resolved = resolveWithinWorkspace(cwd, arg);
  if (resolved === undefined) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/**
 * Normalize a path returned by the port to a **workspace-relative** path (the facade's promised
 * shape). The port may return an absolute or relative path; accept both. Normalize separators
 * to `/`: this value is journaled and interpolated into model prompts, so it must not vary by
 * host platform (the same script should read the same path on Windows and macOS).
 *
 * **The export is intentional** (as with {@link resolveWithinWorkspace}): `sourcePath` in an
 * artifact record has the same shape—workspace-relative, forward-slash path—and that shared
 * shape must have one definition or the implementations will eventually diverge on Windows.
 */
export function toWorkspaceRelative(cwd: string, path: string): string {
  const rel = resolvePath(cwd, path) === path ? relativePath(cwd, path) : path;
  return rel.replace(/\\/g, "/");
}

/** First line of stderr / stdout for error messages (do not echo the full output). */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Inline limit for git text output (path lists / status / log). These ops have no spec-level
 * limit, but an unbounded buffer is not an option: 100 commits and a worktree path list are
 * orders of magnitude below 4 MB. git.diff does **not** use this value; it has its own 512 KB
 * limit and relies on cap+1 to detect overflow.
 */
const GIT_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One `files.grep` match. The authoritative declaration is `declare interface GrepMatch` in FACADE_DTS. */
interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Short description of an argument shape (for error messages only; do not echo full contents). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
