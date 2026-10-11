import { runInContext, type Context } from "node:vm";
import {
  instrumentForContextPersistence,
  parseReplCode,
  rewriteDynamicImportsForRepl,
} from "./instrument.js";

/**
 * ReplExecutor — strategy seam for "execution + persistence across calls" (A-ready).
 *
 * NodeReplSession.run calls only executor.run, so switching implementations switches execution strategies:
 * - Strategy B (current): IifeContextExecutor — instrument top-level declarations → async IIFE → runInContext.
 * - Strategy A (future, requires --experimental-vm-modules): SourceTextModuleExecutor — harvest-style instrument
 *   → SourceTextModule.evaluate → collect the namespace. The main flow stays unchanged; replace only this implementation.
 *
 * Contract: return the completion value; throw on error (NodeReplSession's try/catch normalizes it into a structured error).
 * signal supports cancellation (timeout/stop).
 */
export interface ReplExecutor {
  run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs?: number,
  ): Promise<unknown>;
}

/**
 * Strategy B executor: parse user code and instrument top-level declarations so they are copied to the persistent context (globalThis),
 * then wrap it in an async IIFE for top-level await and execute it with runInContext in the persistent context.
 *
 * If parsing fails, fall back to the original code so instrumentation cannot break execution; top-level const/let bindings will not persist, but the code can still run.
 */
export class IifeContextExecutor implements ReplExecutor {
  async run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs = 5_000,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    // Instrument by injecting globalThis assignments after top-level declarations; fall back unchanged if parsing fails.
    const rewrittenCode = rewriteDynamicImportsForRepl(code);
    const rewrittenParsed = parseReplCode(rewrittenCode);
    const effectiveCode =
      "ast" in rewrittenParsed
        ? instrumentForContextPersistence(rewrittenCode, rewrittenParsed.ast)
        : rewrittenCode;

    // Wrap in an async IIFE to support top-level await. Dynamic loading uses the injected importModule (see NodeReplSession.buildContext);
    // do not pass importModuleDynamically, which would require vm's --experimental-vm-modules flag.
    const wrapped = `(async () => {\n${effectiveCode}\n})()`;
    // A Promise race can cancel only async code that has yielded back to the event loop; `while(true){}`
    // would occupy the agent thread forever, preventing the outer timeout/AbortSignal timer from running.
    // V8 interrupt checks enforce vm's synchronous execution budget and can actually break an infinite synchronous loop. The budget covers only
    // the synchronous runInContext segment; after await, AbortSignal racing handles asynchronous waits.
    const promise = runInContext(wrapped, context, {
      timeout: Math.max(1, Math.trunc(syncTimeoutMs)),
    }) as Promise<unknown>;

    return signal ? await raceAbort(promise, signal) : await promise;
  }
}

function abortReason(signal: AbortSignal): unknown {
  // AbortSignal.timeout uses TimeoutError as its reason. Rewriting it to AbortError would make
  // MCP hard timeouts indistinguishable from user stops and prevent accurate kernel-reset recovery guidance.
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "name" in reason) return reason;
  return new DOMException(typeof reason === "string" ? reason : "aborted", "AbortError");
}

/** Race a promise against signal.abort: reject immediately with signal.reason if aborted; otherwise pass through the promise result. */
function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
