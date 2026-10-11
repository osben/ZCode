/**
 * Parent-process harness (the host side of Boundary A + sandbox process orchestration).
 *
 * Responsibility: run a workflow script (or already lowered function body) in a controlled
 * child process, bridge the child's `__host.*` calls over NDJSON to a {@link WorkflowEngine}
 * instance, and return the engine's {@link RunSettlement}. This package depends **only** on
 * `@zcode/dynamic-workflow` and Node built-ins, proving the full pipeline runs without app
 * dependencies. It never imports `@zcode/core`/`@zcode/contracts`/`@zcode/bootstrap`/`@zcode/adapters`.
 *
 * Sequence (happy path):
 *
 *   parent                         child(vm)
 *     │  write <cwd>/.zcode/workflow-runs/<runId>.mjs (payload: lowered+args embedded)
 *     │  spawn(node <entry>)
 *     │──────────────────────────▶│  build __host in context
 *     │◀── create-actor(local#1) ──│  createActor returns local#1 synchronously
 *     │  map local#1 → ActorId     │
 *     │◀── request ask(local#1) ───│  await __host.ask(...)
 *     │  engine.ask → driver.startAsk … settle
 *     │── response(value) ────────▶│  resolve
 *     │◀────── complete(ok,value) ──│  script returns
 *     │  engine.complete(value) → settled=completed
 *
 * Failure/cancellation: the engine owns run verdicts. Terminal failures (script throws
 * error-complete, child process crashes/exits nonzero, wall-clock timeout, or child-line JSON
 * parse failure) all call `engine.fail(error)` (settle as failed + journal failure_json).
 * An abort signal is the only "real cancellation" and calls `engine.stop(initiator)` (settle as
 * stopped; `signal.reason` of `"model"` means main-agent TaskStop, `"interrupted"` means the host
 * App stopped a run it owns, and all other reasons count as user cancellation). Engine-level
 * run failures (reportCap/inputHash/unknownActor) also surface through engine.settled. The
 * harness's first-wins finalize only cleans up the child process (clear timer, close stdin, kill
 * child); it does not settle the run itself.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  lowerWorkflowScript,
  WorkflowEngine,
  WorkflowError,
  type ActorId,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type RunSettlement,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { type ChildMessage, type ChildPayload, type ResponseMessage } from "./protocol.js";
import { renderChildEntry } from "./child-source.js";
import { writeChildEntryFile, type HarnessWarning } from "./child-entry-file.js";

/** Driver factory: the harness first creates the sink (the engine's upward reporting surface),
 * passes it to the factory to create a driver, then builds the engine with that driver. */
export type DriverFactory = (sink: WorkflowReportSink) => WorkflowDriver;

/**
 * The run's **live control surface**: after constructing the engine, the harness binds this
 * run's engine to it, so the holder of the handle (the run service) can reach the live engine.
 * Two commands — change this run's concurrency limit in place
 * (docs/dynamic-workflow/concurrency.md "Two bounds on a run") and fill one hole
 * (docs/execution-engine.md "Holes").
 *
 * Plus two read-only surfaces, `openHoles` / `filledHoles`: `holes[].state === "waiting"` in the
 * run snapshot must be projected from the engine's parked table (docs/execution-engine.md "The run
 * snapshot" — after the process has died there is no promise waiting, and reading events alone
 * would report holes nobody asked about as waiting), and this binding is the only seam where the
 * run service reaches the live engine.
 *
 * Narrow the surface to `Pick<…>` rather than exposing the whole engine:
 * this is a **command** channel, not a backdoor for the host to bypass the harness and drive run
 * lifecycle (settlement still occurs only through complete/stop/fail).
 *
 * Like `signal`, the harness only wires it through; it does not interpret, validate, or provide
 * a fallback. Liveness checks and no-op semantics belong to the engine (`setMaxConcurrency`
 * returning false means nothing happened).
 */
export interface RunControlBinding {
  bind(
    engine: Pick<WorkflowEngine, "setMaxConcurrency" | "fillHole" | "openHoles" | "filledHoles">,
  ): void;
}

/**
 * Arguments to {@link runWorkflowScript}. The executable body comes from `scriptText` or
 * `lowered` (the latter takes precedence). Providing both is the "compile once" form: the caller
 * compiles to `lowered` and also passes the author's `scriptText` for persistence.
 *
 * **The harness never checks whether this pair is consistent**: it cannot do so without
 * determining whether `lowered` really came from `scriptText`, which would compile it again
 * and defeat the "compile once" path. If the caller passes a mismatched pair, persisted
 * `script_text` will not match the code actually run and the resume comparison baseline will
 * be invalid. Consistency belongs to the caller.
 */
export interface RunWorkflowOptions {
  /**
   * Author-written workflow source, used for two purposes:
   * 1. If `lowered` is missing, the harness lowers it to produce the executable body.
   * 2. **Always** persist it as run metadata in `dwf_run.script_text` (resume compares against
   *    the author's original source, not the lowered function body).
   */
  scriptText?: string;
  /**
   * Already lowered async function body (the only free identifier is `__host`). Bypass the
   * compiler and pass it directly to the sandbox: security tests use this to feed a hand-written
   * lowered body (the VM contract itself is under test), while the compile-once path passes its
   * own compilation output. When provided, this takes precedence over `scriptText` as the body.
   */
  lowered?: string;
  runId?: string;
  /** Driver factory (see {@link DriverFactory}). The driver includes journal and emit. */
  makeDriver: DriverFactory;
  caps: Caps;
  /** Static spec for each ask site. **Must cover every ask site in the script**; the engine treats missing entries as wiring errors and fails. */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /**
   * Site → lexical birth phase name (`collectSitePhases`); forwarded verbatim to
   * `EngineConfig.sitePhases`. Omission means an empty table: the engine falls back to the dynamic
   * current phase for every site (legacy compiled artifacts, snippets, directly fed lowered bodies).
   */
  sitePhases?: ReadonlyMap<string, string>;
  /** Injected schema validator (the engine does not import the schema implementation). */
  validate: ValidateFn;
  /** External cancellation signal: abort the in-flight ask and kill the child process; settle the run as cancelled. */
  signal?: AbortSignal;
  /**
   * Binding point for the live control surface (see {@link RunControlBinding}). Passed through
   * the same seam as `signal`: that channel stops the run, while this one changes one run
   * setting. If absent, this invocation has no control surface (integration tests, snippet
   * execution).
   */
  control?: RunControlBinding;
  /** Wall-clock timeout (ms): kill the child process at expiry and settle the run as failed. Unlimited by default. */
  timeoutMs?: number;
  /** Child-process heap limit (MB), mapped to `--max-old-space-size`. Defaults to 256. */
  maxOldSpaceSizeMb?: number;
  /**
   * Alternate child-process spawn strategy: when provided, spawn
   * `process.execPath [...argsPrefix, <entry path>]` with **no Node CLI flags**.
   *
   * Reason: an SEA single-file binary does not interpret Node CLI flags, so the default path's
   * `--max-old-space-size` would be parsed as an ordinary token by strict CLI parseArgs and
   * always fail (every workflow run would fail under SEA). Under SEA, bootstrap passes a hidden
   * subcommand name as argsPrefix; the child re-executes this binary, `import()`s the entry file
   * before parseArgs, and calls its `start` function.
   *
   * Tradeoff: the entry file can only set the heap limit best-effort using `v8.setFlagsFromString`.
   */
  childSpawn?: { argsPrefix: readonly string[] };
  /**
   * Reporting channel for non-fatal conditions (currently only one: the entry file could not
   * be written to the project's `.zcode/`, so it fell back to the OS temporary directory).
   * The harness is app-free and has no logger; bootstrap connects this to its warn log.
   */
  onWarning?: (warning: HarnessWarning) => void;
  /** Child-process working directory, defaults to process.cwd(); also persisted as run metadata in dwf_run.cwd. */
  cwd?: string;
  /**
   * Run metadata, passed **verbatim** to `EngineConfig` (createRun persists it to dwf_run).
   * All fields are optional; the harness does not transform or infer them. `scriptHash` is
   * **computed by the caller**. If the harness hashed "the text it sees," the lowered path
   * would persist a hash of the lowered function body, giving resume validation a silently
   * incorrect comparison target. The original script is passed through `scriptText` above.
   */
  scriptHash?: string;
  parentSessionId?: string;
  /** Run display name (source of the host's list label). Passed through like `scriptText`. */
  name?: string;
  /**
   * Arguments for this run (declarative parameters of the saved workflow, already validated and
   * filled with defaults by the caller).
   *
   * **Two destinations**, unlike the other metadata: it is persisted with `EngineConfig` to
   * `dwf_run.args_json` (resume reads it back for replay) and included in the spawn payload as a
   * frozen `args` global in the sandbox. The harness does not validate or transform it; the
   * caller (tool side) owns declaration and validation. Missing means `{}`.
   */
  args?: Record<string, unknown>;
  /** CreateWorkflow tool call ID that started the run (join/notification anchor after restart); passed verbatim to EngineConfig. */
  toolCallId?: string;
  /**
   * Two inputs for amend-resume, governed like other metadata: **passed verbatim to EngineConfig**;
   * the harness does not read, transform, or infer them. `resumedFrom` is the lineage pointer
   * persisted as `dwf_run.resumed_from`; `importedCache` is a pure-data cache table injected into
   * the engine.
   *
   * As with the `scriptText`/`lowered` pair, **the caller owns consistency between them**. The
   * harness cannot determine whether this table was really built from that predecessor run
   * (that would require reading the journal, and this package does not know about storage).
   * Passing a mismatched table would make this run use someone else's answers as its cache.
   * Construction and validation both belong to the run service
   * (bootstrap's dynamic-workflow-import.ts).
   */
  resumedFrom?: string;
  /**
   * Anchor for the turn that started the run; passed verbatim to EngineConfig.
   * `subagentModel` travels with the anchor and phase table: the canonical picker string for
   * this run's subagents (`providerId/modelId[$reasoningLevel]`). The harness does not read,
   * parse, or transform it; it lives in the `run-launched` event without SQL, while parsing and
   * priority rules belong to the host (bootstrap's workflow-actor-model.ts).
   * `phaseAlongside` and `phaseNames` align by position (each index refers to the same table)
   * and travel under the same rules.
   */
  launch?: {
    inputId: string;
    phaseNames?: string[];
    subagentModel?: string;
    /** Models named by the script → canonical strings (docs/dynamic-workflow/launch.md "Models the script names"), same payload, same rules. */
    modelBindings?: Record<string, string>;
    phaseAlongside?: number[][];
    /** Indices of unfilled holes within `phaseNames` (docs/execution-engine.md "Holes"), same payload, same rules. */
    holes?: number[];
  };
  importedCache?: ImportedRunCache;
  /**
   * Usage baseline when creating the run (the predecessor run's `spentTokens`); passed like the
   * other metadata: **verbatim to EngineConfig**, without reading or transforming it here. The
   * run service reads the predecessor row.
   */
  inheritedTokens?: number;
}

const DEFAULT_MAX_OLD_SPACE_MB = 256;
const STDERR_LIMIT = 64 * 1024;

/**
 * Run a workflow script to settlement and return the engine's {@link RunSettlement}.
 * Failures are first-class and split into two categories: a script exception is a script error,
 * normalized to `{status:"errored", error}`; failure to start the child, a crash, wall-clock
 * timeout, or protocol corruption is a host fault that may succeed on retry, normalized to
 * `{status:"stopped", reason:"interrupted", error}` (resumable). Neither category is silently
 * swallowed.
 */
export async function runWorkflowScript(options: RunWorkflowOptions): Promise<RunSettlement> {
  const lowered = resolveLowered(options);
  const runId = options.runId ?? "run";

  // Bind the sink later: the engine is constructed after the driver, but the driver needs the
  // sink for reports. A forwarding proxy breaks this circular dependency.
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
    askTurnEnded: (instance, finalText) => engine.askTurnEnded(instance, finalText),
    askProgress: (instance, progress) => engine.askProgress(instance, progress),
    askStats: (instance, stats) => engine.askStats(instance, stats),
    askFailed: (instance, error) => engine.askFailed(instance, error),
    // Deterministic model-side error → stop the entire run; this is also only forwarded.
    stopRun: (error) => engine.stopRun(error),
    // The three adaptive-concurrency observations and run-level stall observation are also only forwarded.
    askWaiting: (instance, info) => engine.askWaiting(instance, info),
    askExecuting: (instance) => engine.askExecuting(instance),
    // The only observation that makes the engine decide (close the import cache) is also only forwarded.
    askMutating: (instance) => engine.askMutating(instance),
    concurrencyChanged: (change) => engine.concurrencyChanged(change),
    runStalled: (info) => engine.runStalled(info),
  };
  const driver = options.makeDriver(sink);
  engine = new WorkflowEngine({
    runId,
    driver,
    caps: options.caps,
    askSpecs: options.askSpecs,
    validate: options.validate,
    ...(options.sitePhases === undefined ? {} : { sitePhases: options.sitePhases }),
    // Pass metadata verbatim and keep missing fields absent (do not write undefined keys). The
    // cwd here is the same value used by the child process, including the process.cwd() fallback,
    // so the persisted cwd is the directory where the run actually executes.
    ...(options.scriptText === undefined ? {} : { scriptText: options.scriptText }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.scriptHash === undefined ? {} : { scriptHash: options.scriptHash }),
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    ...(options.resumedFrom === undefined ? {} : { resumedFrom: options.resumedFrom }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.importedCache === undefined ? {} : { importedCache: options.importedCache }),
    ...(options.inheritedTokens === undefined ? {} : { inheritedTokens: options.inheritedTokens }),
    cwd: options.cwd ?? process.cwd(),
  });
  // Bind the control surface as soon as it is constructed: settings can be changed from the
  // run's first event, without waiting for the child process to start. The spawn-failure path
  // below also settles through the engine, so the handle remains safe afterward (the command's
  // own settled check closes it).
  options.control?.bind(engine);

  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  const cwd = options.cwd ?? process.cwd();
  const payload: ChildPayload = {
    lowered,
    // Arguments cross the boundary once at startup and remain constant for the run's lifetime.
    ...(options.args === undefined ? {} : { args: options.args }),
    // Include the heap limit in the payload for the argsPrefix path only: that path cannot pass
    // Node flags, so the entry file must set it best-effort. The default path uses the actual
    // flag, and the entry file skips setting it when it sees that flag.
    maxOldSpaceSizeMb,
  };

  // Do not pass the payload on the command line: Windows limits command lines to 32,767
  // characters, and the full lowered script would exceed that at roughly 18 KB, causing
  // `spawn ENAMETOOLONG`. Write it to an entry file so argv contains only one path and its
  // length does not depend on script size.
  let child: ChildProcess;
  try {
    const entry = writeChildEntryFile({
      cwd,
      runId,
      source: renderChildEntry(payload, { runId }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    child = spawn(
      process.execPath,
      options.childSpawn === undefined
        ? [`--max-old-space-size=${maxOldSpaceSizeMb}`, entry.path]
        : [...options.childSpawn.argsPrefix, entry.path],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // The desktop agent runs through Electron Helper (process.execPath points to Helper),
        // while CLI startup sanitizes ELECTRON_RUN_AS_NODE from its own environment. Without
        // setting it explicitly, the child starts as a full Electron/Chromium app and hangs
        // during GPU initialization—silent and never exiting, leaving the run stuck at
        // run-started. This variable has no effect with a plain Node execPath (same handling as
        // official-plugin-runtime.ts). Both spawn strategies need it because packaged desktop
        // builds may also use argsPrefix.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
  } catch (cause) {
    // Node converts only EACCES/EAGAIN/EMFILE/ENFILE/ENOENT into error events; other spawn
    // failures (ENAMETOOLONG, E2BIG, etc.) **throw synchronously**. By then the engine exists and
    // the journal row is persisted as running. Letting the exception escape would bypass engine
    // settlement: the registry would show a terminal state while the journal stayed running,
    // and a later resume_from would be rejected as "has not settled yet." The same applies when
    // writing the entry file fails in both directories. Always settle through the engine as
    // stopped(interrupted), a resumable host failure.
    const message = cause instanceof Error ? cause.message : String(cause);
    engine.stop(
      "interrupted",
      new WorkflowError("Interrupted", `Could not start the workflow sandbox process: ${message}`, {
        cause,
      }),
    );
    return engine.settled;
  }

  return bridge({ child, engine, runId, signal: options.signal, timeoutMs: options.timeoutMs });
}

/** Resolve the lowered body: prefer `lowered`; otherwise lower `scriptText` (invalid script
 * throws without starting the child process). */
function resolveLowered(options: RunWorkflowOptions): string {
  if (options.lowered !== undefined) return options.lowered;
  if (options.scriptText === undefined) {
    throw new Error("runWorkflowScript: pass either scriptText or lowered");
  }
  const result = lowerWorkflowScript(options.scriptText);
  if (!result.ok || result.lowered === undefined) {
    const detail = result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
    throw new Error(
      `runWorkflowScript: the script failed compilation/analysis and is not run degraded: ${detail}`,
    );
  }
  return result.lowered.code;
}

interface BridgeDeps {
  child: ChildProcess;
  engine: WorkflowEngine;
  /** Used only in the normalized abort error text (the "interrupted" case names which run was stopped). */
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * NDJSON bridge + lifecycle convergence. Single-writer finalize: whether triggered by engine
 * settlement, child exit, timeout, or abort, the first one wins, then kills the child and
 * resolves the result.
 */
function bridge(deps: BridgeDeps): Promise<RunSettlement> {
  const { child, engine, runId, signal, timeoutMs } = deps;

  // local#N (child-local handle) → engine ActorId mapping. stdio FIFO and synchronous
  // create-actor handling ensure the mapping is ready before any ask referencing the handle arrives.
  const actorMap = new Map<string, ActorId>();
  let stderr = "";
  let finalized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Interface | undefined;

  return new Promise<RunSettlement>((resolve) => {
    const finalize = (settlement: RunSettlement): void => {
      if (finalized) return;
      finalized = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      reader?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(settlement);
    };

    // Terminal failures (script exception / child crash / timeout / protocol corruption) all
    // fail the run: use the engine's public fail(), which settles first-wins, cancels in-flight
    // asks through the driver, and records failed + failure_json in the journal. The engine
    // owns the verdict, so the journal and caller see the same result. finalize (through
    // engine.settled) handles child cleanup.
    const failRun = (error: WorkflowError): void => {
      if (finalized) return;
      engine.fail(error);
    };
    // Host-side fault (sandbox crash / timeout / protocol corruption): stopped(interrupted), resumable.
    const interruptRun = (message: string, cause?: unknown): void => {
      if (finalized) return;
      engine.stop(
        "interrupted",
        new WorkflowError("Interrupted", message, cause === undefined ? undefined : { cause }),
      );
    };

    // Abort is the only "real cancellation": call engine.stop(initiator) and settle as stopped.
    // initiator comes from `AbortController.abort(reason)`: the literal "model", the amend-path
    // `{ superseded: newRunId }` (the successor ID is persisted with the same reason), the
    // literal "interrupted" (host App shutdown, see below), or "user" for everything else.
    function onAbort(): void {
      if (finalized) return;
      const reason: unknown = signal?.reason;
      const supersededBy = readSupersededBy(reason);
      if (supersededBy !== undefined) {
        engine.stop("superseded", undefined, supersededBy);
        return;
      }
      // The host stops a run it owns (run service close()). This is not user cancellation: persist
      // the Interrupted failure code, in the same category as timeout/sandbox crash.
      // stopped(interrupted) is resumable, while stopped(user) appears in the UI as "user pressed
      // stop." The error text names the run and cause so the detail page can explain this row on
      // the next activation.
      if (reason === "interrupted") {
        engine.stop(
          "interrupted",
          new WorkflowError(
            "Interrupted",
            `dynamic workflow run ${runId} was interrupted: the owning session closed before the run settled`,
          ),
        );
        return;
      }
      engine.stop(reason === "model" ? "model" : "user");
    }

    // Every settlement (complete / fail / stop / engine-internal cap failure) reaches finalize through engine.settled.
    void engine.settled.then(finalize);

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        interruptRun(
          `The workflow sandbox process exceeded its wall-clock timeout of ${timeoutMs}ms`,
        );
      }, timeoutMs);
      timer.unref?.();
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = trimTail(stderr + chunk.toString("utf8"), STDERR_LIMIT);
    });
    // A response may still be pending after the child exits; listen for stdin errors so EPIPE
    // does not become an uncaught exception.
    child.stdin?.on("error", () => undefined);

    reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch (cause) {
        // Malformed child-line JSON: surface it instead of swallowing it.
        interruptRun(
          `The workflow sandbox process emitted a line that is not valid NDJSON: ${line}`,
          cause,
        );
        return;
      }
      handleChildMessage(message, { engine, actorMap, child, failRun });
    });

    child.on("error", (error) => {
      interruptRun(`Could not start the workflow sandbox process: ${error.message}`, error);
    });

    child.on("close", (code, sig) => {
      if (finalized) return;
      // Child exited before engine settlement: it crashed/was killed without complete. Use stderr for attribution.
      const reason =
        stderr.trim().length > 0
          ? stderr.trim()
          : `The workflow sandbox process exited (code=${code}, signal=${sig}) before completing`;
      interruptRun(reason);
    });
  });
}

interface MessageDeps {
  engine: WorkflowEngine;
  actorMap: Map<string, ActorId>;
  child: ChildProcess;
  failRun: (error: WorkflowError) => void;
}

/** Dispatch a child→parent message. Bridge ask/world-read asynchronously to the engine and
 * return a response (with the latest budget). */
function handleChildMessage(message: ChildMessage, deps: MessageDeps): void {
  const { engine, actorMap, child, failRun } = deps;

  switch (message.kind) {
    case "create-actor": {
      // Handle synchronously so the mapping exists before any ask references this handle (stdio
      // FIFO assumption). createActor is synchronous and throws if the run already settled; there
      // is no response channel at that point, so catch it and classify it as run failure (usually
      // a harmless shutdown race).
      try {
        const actorId = engine.createActor(
          message.siteId,
          message.name,
          message.persona as string | undefined,
        );
        actorMap.set(message.localId, actorId);
      } catch (cause) {
        failRun(
          cause instanceof WorkflowError
            ? cause
            : new WorkflowError("DriverError", `createActor failed at site ${message.siteId}`, {
                cause,
              }),
        );
      }
      return;
    }
    case "event":
      // Dispatch synchronously, as with log: FIFO order on the event channel is essential for
      // both report and declare-artifact (the parent journal records arrival order, and a tagged
      // report must be persisted after its declaration). Making this asynchronous would
      // decouple arrival order from journal order.
      if (message.type === "report") {
        engine.report(message.siteId, message.item, message.artifactId);
      } else if (message.type === "declare-artifact") {
        engine.declareArtifact(message.siteId, message.op, message.args);
      } else if (message.type === "phase-entered") {
        engine.enterPhase(message.name);
      } else {
        engine.log(message.message);
      }
      return;
    case "complete":
      if (message.ok) {
        engine.complete(message.value);
      } else {
        // Script exception: fail the run (details come from the sandbox).
        const err = message.error;
        failRun(
          new WorkflowError("DriverError", err?.message ?? "The workflow script threw an error", {
            cause: err?.stack ?? err?.name,
          }),
        );
      }
      return;
    case "request":
      handleRequest(message, { engine, actorMap, child, failRun });
      return;
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

/** Bridge one host call requiring a response (ask / world-read / publish-artifact / hole) to the engine, then respond after settlement. */
function handleRequest(
  message: Extract<ChildMessage, { kind: "request" }>,
  deps: MessageDeps,
): void {
  const { engine, actorMap, child } = deps;

  const respond = (ok: boolean, value: unknown, error?: WorkflowError): void => {
    const response: ResponseMessage = {
      kind: "response",
      id: message.id,
      ok,
      ...(ok ? { value } : { error: toWireError(error) }),
    };
    // The child may have exited (cancellation/failure cleanup): write only if possible. Contain
    // EPIPE and other I/O races at this boundary because the run has already settled.
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) return;
    stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
  };

  let promise: Promise<unknown>;
  if (message.type === "ask") {
    const actorId = actorMap.get(message.actor ?? "");
    if (actorId === undefined) {
      // Missing mapping (should be impossible because FIFO guarantees order): return a
      // structured UnknownActor rejection instead of failing silently.
      respond(
        false,
        undefined,
        new WorkflowError("UnknownActor", `Unknown subagent handle: ${message.actor}`),
      );
      return;
    }
    promise = engine.ask(message.siteId, actorId, message.instructions ?? "");
  } else if (message.type === "publish-artifact") {
    const op = message.artifactOp;
    if (op === undefined) {
      // Missing op is a wiring error (lowering always supplies it). **Do not invent a default**:
      // a markdown publish treated as a file would fail far from the cause. Return a structured
      // rejection visible to the script.
      respond(
        false,
        undefined,
        new WorkflowError(
          "DriverError",
          `publish-artifact request is missing artifactOp (site ${message.siteId})`,
        ),
      );
      return;
    }
    promise = engine.publishArtifact(message.siteId, op, message.args ?? []);
  } else if (message.type === "hole") {
    // Hole: the engine parks the promise at the site; only after the main agent releases it via the
    // control plane's fillHole is there a `{code}` to answer with; until then it is just an
    // in-flight request (docs/execution-engine.md "The vm cell").
    promise = engine.hole(message.siteId, message.name ?? "", message.prompt);
  } else {
    // Pass op/args unchanged to the engine: this layer does not inspect op or validate arity
    // (that is the driver's responsibility). Normalize missing args to an empty array so the
    // driver's argument validation can reject it loudly instead of inventing a default here.
    promise = engine.worldRead(message.siteId, message.op ?? "read", message.args ?? []);
  }

  promise.then(
    (value) => respond(true, value),
    (cause: unknown) => {
      const error =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError(
              "DriverError",
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
      respond(false, undefined, error);
    },
  );
}

/** Convert WorkflowError to its wire shape (preserve code/violations/finalText for structured
 * try/catch handling in sandbox scripts). */
function toWireError(error: WorkflowError | undefined): ResponseMessage["error"] {
  if (error === undefined) return { name: "Error", message: "unknown error" };
  const wire: NonNullable<ResponseMessage["error"]> = {
    name: error.name,
    message: error.message,
    code: error.code,
  };
  if (error.violations !== undefined) wire.violations = error.violations;
  if (error.finalText !== undefined) wire.finalText = error.finalText;
  return wire;
}

/** Keep the content within the last limit bytes of a string (stderr truncation). */
function trimTail(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return value.slice(-limit);
}

/** Extract the successor ID when the abort reason is `{ superseded: <runId> }`; return undefined for other shapes. */
function readSupersededBy(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const value = (reason as { superseded?: unknown }).superseded;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
