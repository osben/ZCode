/**
 * Sandboxed child-process logic. **One implementation, one entry file, two launch methods**:
 *   - {@link renderChildEntry} renders {@link childMain} via `toString()` together with payload
 *     as a self-contained ESM file; the harness writes it to
 *     `<cwd>/.zcode/workflow-runs/<runId>.mjs` (child-entry-file.ts).
 *   - Regular Node: `node --max-old-space-size=N <entry>`; the entry file self-starts when it
 *     detects that it is the process entry point.
 *   - SEA single-file binary: the CLI's hidden subcommand `__zcode-dwf-child <entry>` imports
 *     this file and calls its exported `start(deps)`, injecting vm/readline/stdio from the CLI
 *     process (the SEA main program does not interpret Node CLI flags, so `--eval` cannot work).
 *
 * Windows command lines are limited to 32,767 characters. `--eval CHILD_SOURCE -- <base64url
 * payload>` puts the full lowered script on the command line; once the script exceeds roughly
 * 18 KB, `spawn ENAMETOOLONG` prevents any longer run from starting on Windows.
 *
 * Structure:
 *   - The outer realm ({@link childMain} itself) is ordinary Node code holding stdio, readline,
 *     and vm for transport.
 *   - Evaluation happens in a **separate realm** created by `vm.createContext(...)`, containing
 *     only ES intrinsics and injected `__host`. A bare vm context has no
 *     `process`/`require`/`Buffer`/`fetch` and no timers; we add only `__host` and runtime
 *     restrictions. channel / future and stall detection (docs/dynamic-workflow/authoring.md
 *     "Streams") are both implemented inside the cell: the former is a pure promise mechanism,
 *     and the latter holds precisely because "the cell has no other wake-up source".
 *
 * Cross-realm containment (prevent prototype leakage / prototype pollution): everything the
 * script touches (Promise, JSON-parsed host results, Error) is constructed **inside the
 * context**. Only two values cross between the outer realm and the context: the outer
 * `__send(string)` function and inbound line strings (strings are primitives with no realm
 * ownership). Thus `Array.isArray`/`instanceof`/prototype chains are all context-native from the
 * script's perspective and never mix in outer-realm intrinsics.
 *
 * Dynamic imports: runFn is compiled by `vm.runInContext` (Script, without an
 * importModuleDynamically callback), so runtime `import()` throws
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `eval`/`Function` use the same context global.
 *
 * This file is a **hand-maintained mirror** of protocol.ts wire protocol: childMain runs as an
 * embedded string in the entry file and cannot import protocol.ts. Changes to either must be
 * mirrored in the other. Therefore {@link childMain} may import **types** only (erased at
 * compile time) and must never add runtime package dependencies; the module's sole value import
 * (the bootstrap string from child-cell-streams.ts) is read and embedded into the entry file by
 * {@link renderChildEntry} only, and childMain itself receives it through deps.
 */

import { CELL_STREAMS_BOOTSTRAP } from "./child-cell-streams.js";
import type { ChildPayload } from "./protocol.js";

/** Entire `node:vm` surface used by {@link childMain} (narrowed to two functions; this is the child-process VM contract). */
export interface ChildVmModule {
  createContext(sandbox: object, options?: { name?: string }): object;
  runInContext(code: string, sandbox: object, options?: { filename?: string }): unknown;
}

/** `readline.Interface` surface used by {@link childMain}. */
export interface ChildReadlineInterface {
  on(event: "line", listener: (line: string) => void): unknown;
  close(): void;
}

/**
 * Host capabilities injected into {@link childMain}. **Each launch method provides real
 * implementations**: when the entry file self-starts, it obtains them from `node:vm` /
 * `node:readline` / `process`; the SEA subcommand obtains them from the CLI process.
 */
export interface ChildMainDeps {
  vm: ChildVmModule;
  createInterface(options: { input: NodeJS.ReadableStream }): ChildReadlineInterface;
  /** Source of inbound responses (parent-process stdin pipe). Holding it also keeps the event loop alive. */
  stdin: NodeJS.ReadableStream;
  /** Destination for outbound NDJSON; {@link childMain} adds the newline. */
  stdout: { write(chunk: string): unknown };
  /**
   * Payload for this run ({@link import("./protocol.js").ChildPayload}). The entry file embeds it
   * as a JSON literal and passes it through unchanged; it no longer travels through argv or base64.
   */
  payload: ChildPayload;
  /**
   * The cell's second bootstrap script: channel / future and stall detection
   * ({@link import("./child-cell-streams.js").CELL_STREAMS_BOOTSTRAP} in child-cell-streams.ts).
   * It travels the same path as payload—the entry file embeds it as a string literal and `start`
   * passes it through—because childMain's self-containment constraint forbids referencing
   * module-scope bindings, and keeping it in this file would burst the single-file line limit.
   * It runs in the same context after BOOTSTRAP and before the lowered body, reading and writing
   * the context globals that BOOTSTRAP created with `var`.
   */
  streamsBootstrap: string;
}

/**
 * **Only** entry point for the sandbox child process. The returned promise resolves after script
 * execution ends (complete has been sent and stdin closed).
 *
 * Why it must be awaitable: the SEA subcommand runs in the CLI process, whose entry point starts
 * a 1s exit watchdog after `run()` returns (`scheduleCliExitWatchdog` in shutdown.ts). If the
 * child logic simply "sets up readline and returns synchronously," the watchdog would kill the
 * entire child just as the run starts. The self-starting entry file does not need this promise
 * (the process exits naturally when the event loop is idle), but both launch methods share one
 * implementation, so childMain provides the completion signal for both.
 *
 * Self-containment constraints (functional, not stylistic). {@link renderChildEntry} embeds this
 * function as **source** using `childMain.toString()`, so its body must stand alone:
 *   1. Reference only parameters, language intrinsics, and Node globals such as `Buffer`;
 *      **never reference module-scope bindings** (constants, helper functions, imports). This is
 *      why the sandbox bootstrap is inline in the function body, not a module-level constant.
 *   2. **Never name inner functions**; see the comment in the function body for the rationale and
 *      previous failure (esbuild `minify + keepNames` wraps them in the module-scope `__name` helper).
 * Verify both constraints against real bundled/minified output; source tests alone cannot catch
 * regressions of this kind.
 */
export function childMain(deps: ChildMainDeps): Promise<void> {
  /**
   * Bootstrap script run inside the vm context (plain JS with no backticks / ${}, so it can be
   * embedded safely). Defines `__host` (Boundary A shims), `__deliver` (consume inbound
   * responses), and `__execute` (run lowered fn), and applies runtime restrictions (Date.now /
   * argless new Date() / Math.random)—the belt; compile-time diagnostics are the suspenders.
   */
  const BOOTSTRAP = String.raw`
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();
// Holes already filled this run: site id → body text. When the same site is reached again (in a
// loop), evaluate directly without crossing the wire.
var __fills = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // Create the child-local handle synchronously and send create-actor fire-and-forget; stdio
  // FIFO lets the parent establish the mapping before any later ask.
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args is the positional argument array packed by lowering; this shim passes it through
  // unchanged and does not inspect op or validate arity (the driver owns that).
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __evaluateFill(evaluate, code) {
  // evaluate is the (__src) => eval(__src) that lowering emits at the site: a direct eval closing
  // over every binding of the author's code at that point (__host included), which yields the
  // (async () => { … }) function; calling it produces the hole's value. Each arrival creates a
  // fresh evaluate, so a hole inside a loop sees that iteration's own bindings. Evaluation
  // failures (syntax errors) and body rejections surface on this promise at the site, where the
  // script can catch them.
  return Promise.resolve().then(function () {
    return evaluate(code)();
  });
}

function __hole(siteId, name, prompt, evaluate, body) {
  // Already filled (the body lives in the script): call the body directly without crossing the
  // wire. Synchronous throws become rejections, same rule as future.
  if (body !== undefined) {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var remembered = __fills.get(siteId);
  if (remembered !== undefined) return __evaluateFill(evaluate, remembered);
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
  }).then(function (answer) {
    __fills.set(siteId, answer.code);
    return __evaluateFill(evaluate, answer.code);
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // Phase marker: no site and no journal entry; it only asks the engine to emit an event, so it
  // uses the same event channel as log.
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // Content artifacts are effects: scripts await them and must be able to catch their
  // rejections, so they use request/response like ask / world-read. args is the positional array
  // packed by lowering ([id, path|content, opts]), passed through unchanged.
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // Predeclared artifacts are declarations: they synchronously return void, so there is nothing
  // to await and they use the event channel. They share a FIFO with report; a tagged report must
  // reach the parent after its declaration, and this ordering guarantees that.
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // Fire and forget: scripts never await it, so use the event channel instead of
  // request/response. The parent journals one row per siteId × ordinal, so **arrival order** is
  // essential (stdio FIFO guarantees it).
  // If item contains a cycle, JSON.stringify throws here at the report() call site; the script
  // can catch it or let the run fail. Both are better than silently sending a partial item; the
  // parent has the same guard.
  // If artifactId is absent, JSON.stringify omits the key, so the wire value is untagged.
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// ── Runtime arguments (Boundary A args) ──
// Like the budget, construct them inside the context with JSON.parse, so scripts receive
// context-native objects without any outer-realm intrinsics (see the cross-realm containment
// constraint at the top of this file).
// Object.freeze is **shallow**: nested objects remain mutable, so the script can still change
// args.foo.bar. v1 accepts this limitation; it prevents accidental reassignment of args, not a
// security boundary (the caller supplied the arguments in the first place).
var __args = Object.freeze(JSON.parse(__argsJson));

globalThis.__host = {
  args: __args,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
  hole: __hole,
};

// ── Consume inbound responses (called by the outer realm with a line string) ──
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // Reject with a context-native Error so code/violations/finalText cross over for structured
  // try/catch handling in the script.
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

// Whether the run has already sent complete. Stall detection (__checkStalled in
// deps.streamsBootstrap) also reads and writes it.
var __settled = false;

function __complete(ok, payload) {
  // Idempotent: once stall detection has ended the run with error-complete, a (theoretical) later
  // script completion must not send a second one.
  if (__settled) return;
  __settled = true;
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// The outer realm calls this to run the script. Always resolve (errors have been converted to
// complete messages) so the outer realm can clean up by closing stdin.
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// ── Runtime restrictions (the belt; compile-time diagnostics are the suspenders): Date.now / argless new Date() / Math.random ──
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;

  // The second self-containment constraint above is easier to violate than "do not import":
  // **never name inner functions**. Root cause (we hit this before adding this test): the CLI
  // desktop-agent build uses `minify + keepNames`, and esbuild rewrites inner functions whose
  // names it can infer (variable declarations such as `const send = …`, function declarations,
  // and object-literal properties) as `__name(fn, "send")`. `__name` is injected at module
  // scope. If it appears in the `toString()` source, the embedded child process throws
  // ReferenceError—**only the minified release artifact breaks**, while source tests pass.
  // Member assignment (`sandbox.__send = …`) and anonymous functions in argument positions are
  // not rewritten, so use only those forms below. Verify against real bundled/minified output.

  const payload = deps.payload;

  // Separate realm: the bare context has only ES intrinsics; inject __send for transport and
  // JSON for arguments.
  // Missing arguments (inline run, legacy journal row) are encoded as "{}": `args` is always
  // defined on the script side, and this sandbox is where that invariant is established.
  const sandbox = {
    __argsJson: JSON.stringify(payload.args ?? {}),
  } as {
    __send: (line: string) => void;
    __argsJson: string;
    __deliver: (line: string) => void;
    __execute: (runFn: unknown) => Promise<void>;
    __checkStalled: () => boolean;
  };
  sandbox.__send = (line) => {
    deps.stdout.write(`${line}\n`);
  };
  deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
  deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });
  deps.vm.runInContext(deps.streamsBootstrap, sandbox, { filename: "workflow-streams.js" });

  // Compile the lowered function body (a context-native async fn; its await creates a context
  // Promise, and import() throws because no callback is supplied).
  let runFn: unknown;
  try {
    runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
      filename: "workflow-script.js",
    });
  } catch (error) {
    // Lowered-body compilation failed: send error-complete and terminate. Deliberately do
    // **not** call process.exit; stdout writes to the pipe asynchronously, and immediate exit
    // would truncate the complete message just sent (the parent would see only "exited without
    // completing" and lose SyntaxError details). There is no reader in the event loop now, so
    // the child exits naturally after flushing.
    const err = error as { name?: string; message?: string; stack?: string } | undefined;
    deps.stdout.write(
      `${JSON.stringify({
        kind: "complete",
        ok: false,
        error: {
          name: err?.name ?? "SyntaxError",
          message: err?.message ?? String(error),
          stack: err?.stack,
        },
      })}\n`,
    );
    return Promise.resolve();
  }

  // stdin keeps the event loop alive; pass each line to the context's __deliver.
  const reader = deps.createInterface({ input: deps.stdin });
  // Stall detection (execution-engine.md "The vm cell"): after each response is delivered, and
  // once after the script starts, ask the cell on **setImmediate** "is there anything left to
  // do". setImmediate runs after all of this turn's microtasks—every continuation the response
  // could trigger has finished—and the cell has no timers or I/O, so "no in-flight requests and
  // not complete" holds forever once it holds at that moment. On a hit the cell has already sent
  // error-complete; here we only close the reader (__execute will never resolve, so cleanup must
  // happen on this path). setImmediate is a Node global, and both launch paths (self-starting
  // entry file / SEA subcommand) run inside Node, satisfying this function's self-containment
  // constraint.
  // ⚠ Both call sites inline setImmediate instead of extracting `const scheduleStallCheck = …`:
  // an inner function whose name can be inferred gets wrapped in the module-scope `__name` helper
  // by minify + keepNames (see the comment above this function);
  // tests/child-source-bundled.test.ts has caught exactly this.
  reader.on("line", (line: string) => {
    if (!line.trim()) return;
    sandbox.__deliver(line);
    setImmediate(() => {
      if (sandbox.__checkStalled()) reader.close();
    });
  });

  // Run the script; close stdin during cleanup and let the process exit when the event loop is
  // idle (the parent also kills it after receiving complete).
  const execution = sandbox.__execute(runFn).then(
    () => reader.close(),
    () => reader.close(),
  );
  setImmediate(() => {
    if (sandbox.__checkStalled()) reader.close();
  });
  return execution;
}

/** Replace characters outside the safe runId set with `_` in entry filenames (filename and header comment use the same sanitization). */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Render the sandbox entry file: a self-contained ESM that the harness writes to disk and starts
 * with `node <entry>`.
 *
 * Contents: payload as a JSON literal (`JSON.stringify` output is a valid JS expression),
 * {@link childMain} embedded via `toString()`, exported `start(deps)`, and two top-level actions:
 *   - Best-effort heap limit: the default path uses the real `--max-old-space-size` flag; SEA
 *     re-exec cannot pass flags, so call `v8.setFlagsFromString` only when it is absent from
 *     `execArgv` (effect is not guaranteed, same as the atomic-command path).
 *   - Self-start check: when `realpath(argv[1])` matches this file (the `node <entry>` case),
 *     self-start using process vm/readline/stdio. When imported by the SEA subcommand, the check
 *     is false and the subcommand calls `start`. Compare realpaths, not raw paths: on macOS,
 *     tmpdir may be a `/var → /private/var` symlink, and `import.meta.url` uses the resolved real
 *     path; a raw comparison would leave the child silently unstarted.
 *
 * The only interpolations are childMain's source and payload JSON. Template literals inside
 * childMain are safe because interpolation is **runtime string concatenation**; embedded text
 * is not parsed again. The real risk is the self-containment constraint in childMain (see its
 * comment). The generated top-level code deliberately avoids template literals to avoid
 * conflicts with the outer `${}`.
 */
export function renderChildEntry(payload: ChildPayload, meta: { runId: string }): string {
  const runId = safeRunId(meta.runId);
  return `// zcode dynamic workflow run ${runId}
// Generated by @zcode/dynamic-workflow-runtime before every launch; safe to delete once the run has settled.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";

export const payload = ${JSON.stringify(payload)};

// The cell's second bootstrap script (channel / future / stall detection), embedded as a literal
// like payload.
export const streamsBootstrap = ${JSON.stringify(CELL_STREAMS_BOOTSTRAP)};

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload, streamsBootstrap });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // Best effort: V8 may ignore flags already consumed at startup; failure must not affect the run.
  }
}

let isProcessEntry = false;
try {
  isProcessEntry =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isProcessEntry = false;
}
if (isProcessEntry) {
  void start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout });
}
`;
}
