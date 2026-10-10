// ============================================================
// Dynamic Workflow Snippet Service (production implementation of DynamicWorkflowSnippetPort).
// ============================================================
// Execution side of EvalWorkflowSnippet for a scratch facade:
// compile once → use the same lowering / sandbox / world-read execution path → in-memory journal → synchronous settlement.
//
// Three invariants:
//   1. **Same execution path.** Compile through createWorkflowProgram (the scratch facade is injected under the same
//      FACADE_FILE_NAME—the facade identity is determined by the declared filename, and changing it silently empties site collection);
//      perform world reads through production executeWorldRead (real filesystem / real git, production caps). Snippets exist
//      for fidelity; a second "close enough" implementation would defeat their purpose.
//   2. **Fully transient.** Use InMemoryJournalStore and a random runId; write no dwf_* rows and register no background task.
//      Disappearing when the process exits is part of the contract, not a defect.
//   3. **Exclude asks at compile time.** The scratch facade has no agent(), so the driver's ask methods are unreachable;
//      throwing DriverError is defense in depth—reaching them at runtime is a wiring bug and should fail loudly.

import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowSnippetEvalOptions,
  DynamicWorkflowSnippetEvalRequest,
  DynamicWorkflowSnippetEvalResult,
  DynamicWorkflowSnippetPort,
  ExecutionPort,
  FileSystemPort,
  Logger,
} from "@zcode/contracts";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  InMemoryJournalStore,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  validate,
  WorkflowError,
  type Caps,
  type JsonSchema,
  type RunEvent,
  type ValidateFn,
  type WorkflowDriver,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { dynamicWorkflowChildSpawn } from "./dynamic-workflow-run-launch.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import { executeWorldRead, type WorldReadDeps } from "./workflow-world-read.js";

/** Log limit (the contract constant is in @zcode/contracts eval-workflow-snippet.ts; avoid a reverse dependency on the tool layer here). */
const MAX_LOGS = 100;
const MAX_LOG_CHARS = 2_048;
/** Serialization limit for the top-level return value. The harness does not measure artifact size (RunSettlement returns it unchanged), so enforce the limit here. */
const MAX_ARTIFACT_BYTES = 256 * 1024;

const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

interface DynamicWorkflowSnippetServiceDeps {
  /** Filesystem port used by files.glob / files.read / files.grep. */
  fileSystemPort: FileSystemPort;
  /** Subprocess execution port used by git.* world-read. */
  executionPort: ExecutionPort;
  logger?: Logger;
  /** Inject parallelism detection so tests can fix it (the floor must be 1; on a two-core machine, parallelism-2 == 0). */
  availableParallelism?: () => number;
}

/** Create the snippet service and return an implementation of {@link DynamicWorkflowSnippetPort}. */
export function createDynamicWorkflowSnippetService(
  deps: DynamicWorkflowSnippetServiceDeps,
): DynamicWorkflowSnippetPort {
  const caps = (): Caps => {
    return {
      // Use the same concurrency limit implementation as run service / governor. Snippets have no asks and do not use the governor.
      maxConcurrency: resolveWorkflowConcurrencyCeiling(deps.availableParallelism),
    };
  };

  return {
    async evalSnippet(
      request: DynamicWorkflowSnippetEvalRequest,
      options?: DynamicWorkflowSnippetEvalOptions,
    ): Promise<DynamicWorkflowSnippetEvalResult> {
      // Compile once: one ts.Program supplies diagnostics, the site table, and lowering (snippet version of run-service invariant 2).
      // Diagnostics include TS1184 / index-access rewrites, matching CreateWorkflow's self-repair readability.
      const workflow = createWorkflowProgram(request.code, { facadeDts: SNIPPET_FACADE_DTS });
      const diagnostics = collectDiagnostics(workflow.program);
      if (diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics };
      }

      const table = collectSites(workflow);
      // world.run: snippets are a workbench for these calls (run real commands through the gate before committing).
      // Non-literal cmd values receive the same diagnostics as production (authorization closes at compile time); the driver revalidates the command set.
      const worldRun = collectWorldRunCommands(workflow, table);
      if (worldRun.diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics: worldRun.diagnostics };
      }
      const lowered = lowerWorkflow(workflow, table);
      // The scratch facade has no agent(), so the site table cannot contain ask sites. An empty schema record makes
      // buildAskSpecs return empty askSpecs (the engine's hard failure on missing specs is naturally satisfied for snippets).
      const askSpecs = buildAskSpecs(table, {});

      const logs: string[] = [];
      let logsTruncated = false;
      const captureLog = (event: RunEvent): void => {
        if (event.type !== "log") return;
        if (logs.length >= MAX_LOGS) {
          logsTruncated = true;
          return;
        }
        const message = event.message;
        if (message.length > MAX_LOG_CHARS) {
          logs.push(message.slice(0, MAX_LOG_CHARS));
          logsTruncated = true;
          return;
        }
        logs.push(message);
      };

      const worldReadDeps: WorldReadDeps = {
        fileSystemPort: deps.fileSystemPort,
        executionPort: deps.executionPort,
        cwd: request.cwd,
        declaredRunCommands: new Set(worldRun.commands),
      };
      const runId = `dwfeval-${randomUUID()}`;
      const childSpawn = dynamicWorkflowChildSpawn();

      const settlement = await runWorkflowScript({
        askSpecs,
        caps: caps(),
        ...(childSpawn === undefined ? {} : { childSpawn }),
        cwd: request.cwd,
        lowered: lowered.code,
        makeDriver: () => createSnippetDriver(worldReadDeps, captureLog),
        // As in run-launch, log a warning when the entry file falls back to the OS temporary directory.
        onWarning: (warning) => {
          deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
            event: "dynamic_workflow.entry_file.fallback",
            module: "bootstrap.app",
            runId,
            ...warning,
          });
        },
        runId,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: request.timeoutMs,
        validate: validateFn,
      });

      deps.logger?.debug?.("Dynamic workflow snippet settled", {
        event: "dynamic_workflow.snippet.settled",
        module: "bootstrap.app",
        runId,
        // The log context's `status` key uses general task terminology; run's three terminal states use a separate key.
        runStatus: settlement.status,
        traceId: request.trace.traceId,
      });

      if (settlement.status === "completed") {
        const oversize = artifactOversize(settlement.artifact);
        if (oversize !== undefined) {
          return {
            kind: "failed",
            error: {
              code: "ArtifactTooLarge",
              message:
                `The snippet's return value serializes to ${oversize} bytes, over the cap of ` +
                `${MAX_ARTIFACT_BYTES} bytes. Return a summary (a count, the first few items) and ` +
                `leave the full data to log() or to the real run.`,
            },
            logs,
            logsTruncated,
          };
        }
        return {
          kind: "completed",
          ...(settlement.artifact === undefined ? {} : { artifact: settlement.artifact }),
          logs,
          logsTruncated,
        };
      }

      if (settlement.status === "errored") {
        return {
          kind: "failed",
          error: { code: settlement.error.code, message: settlement.error.message },
          logs,
          logsTruncated,
        };
      }

      // stopped: a tool call was canceled (abort signal) or the sandbox failed. Normalize this into a structured failure for the caller—snippets
      // have no resume semantics, so the next action for a "stopped experiment" and a "failed experiment" is the same (edit and rerun).
      // For failure stops (sandbox crash / timeout), expose the failure code; otherwise return Cancelled.
      return {
        kind: "failed",
        error:
          settlement.error === undefined
            ? { code: "Cancelled", message: "snippet evaluation was cancelled" }
            : { code: settlement.error.code, message: settlement.error.message },
        logs,
        logsTruncated,
      };
    },
  };
}

/** Return the byte count if value serialization exceeds the limit, otherwise undefined. The value crossed the NDJSON boundary and is therefore JSON-safe. */
function artifactOversize(artifact: unknown): number | undefined {
  if (artifact === undefined) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
  return bytes > MAX_ARTIFACT_BYTES ? bytes : undefined;
}

/**
 * Sessionless driver for snippets: world reads use the production execution path, the journal is in-memory, and ask methods are unreachable
 * (the scratch facade has no agent()). Reaching one is a wiring bug; throw a structured DriverError and fail loudly.
 */
function createSnippetDriver(
  worldReadDeps: WorldReadDeps,
  onEvent: (event: RunEvent) => void,
): WorkflowDriver {
  const askUnreachable = (member: string): WorkflowError =>
    new WorkflowError(
      "DriverError",
      `Snippet driver received ${member}, but the scratch facade has no agent(), so the ask ` +
        `path must be unreachable. This is a wiring bug.`,
    );
  return {
    createActorSession: () => Promise.reject(askUnreachable("createActorSession")),
    startAsk: () => {
      throw askUnreachable("startAsk");
    },
    respondToSubmit: () => {
      throw askUnreachable("respondToSubmit");
    },
    cancelAsk: () => {
      // Idempotent cleanup on the cancellation path (the engine broadcasts cancellation to active asks); snippets have no active asks, so there is nothing to do.
    },
    executeWorldRead: (op, args) => executeWorldRead(worldReadDeps, op, args),
    journal: new InMemoryJournalStore(),
    emit: onEvent,
  };
}
