# NodeReplSession engine spec (T1, generic infrastructure)

> Status: implemented.
> Parent: `2026-07-07-browser-use-cdp-node-repl-spec.md`.
> Scope: the **persistent JS execution engine** inside the agent process, fully decoupled from the browser (usable without one). This document defines the execution semantics of node_repl.

## 1. Scope and location

- File: `apps/zcode-cli/packages/core/src/repl/node-repl-session.ts`. A pure engine without tool definitions (tools are T2), minimally unit-testable (`packages/core/tests/node-repl-session.test.ts`).
- One `NodeReplSession` per zcode session, managed by the T2 handler in a `Map<sessionId, NodeReplSession>` tied to the agent runtime lifecycle.

## 2. Execution semantics

- **Persistent context**: `node:vm` `vm.createContext(sandbox)`. The sandbox object is the `globalThis` the model sees and lives for the session.
- **Cross-call state**: properties set via `globalThis.x = ...` or on the `sandbox` persist across `run()` calls; top-level `let/const/function` do **not** (each `runInContext` is a separate script scope), so the model must attach persistent values to globalThis.
- **Top-level await**: user code is wrapped as `(async () => { <code> })()`; `vm.runInContext` returns that promise and it is awaited.
- **Dynamic module loading**: an injected `importModule(specifier)` still passes through to the host `import()`. Since 2026-07-13 the executor rewrites standard `await import(...)` in user code to this loader by AST, so skills and the model contract use standard `await import(...)` and no private helper is exposed.
- **Module dirs**: `addModuleDir(dir)` accumulates; relative specifiers resolve against registered dirs.

## 3. Interface

```ts
export interface NodeReplWriteSink {
  write(text: string): void;
}

export interface NodeReplRunResult {
  /** Stringified expression/last value (may be undefined). */
  result?: string;
  /** Output collected from nodeRepl.write + console during this run. */
  logs: string;
  /** Structured error when the code throws (never crashes the process). */
  error?: { name: string; message: string; stack?: string };
}

export interface NodeReplSessionOptions {
  /** Extra globals injected into the sandbox (browser execute bridge, agent object, ...). */
  injectedGlobals?: Record<string, unknown>;
  /** Module resolution base dirs (accumulated by js_add_node_module_dir). */
  moduleDirs?: string[];
}

export class NodeReplSession {
  constructor(options?: NodeReplSessionOptions);
  /** Run code; the signal supports cancellation (timeout/stop). */
  run(code: string, options?: { signal?: AbortSignal }): Promise<NodeReplRunResult>;
  /** Discard and rebuild the context, clearing all cross-call state. */
  reset(): void;
  addModuleDir(dir: string): void;
  dispose(): void;
}
```

## 4. Built-in sandbox globals

`console` (tee to the sink), `process`, `Buffer`, `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`queueMicrotask`, `structuredClone`, `require` (host createRequire), `nodeRepl: { write }`, plus `injectedGlobals` (browser `execute`, `agent` skeleton). `globalThis` references the sandbox.

## 5. Output and errors

- **logs**: `nodeRepl.write(...)` and `console.log/info/warn/error` during the run append to a buffer returned as `logs` (empty string if none).
- **result**: the resolved value of the async IIFE when not undefined, safely stringified (JSON first; circular refs/functions degrade to `String()`).
- **error**: a throw or reject is caught and returned as `{name,message,stack}`; the engine **never throws**, so the agent process cannot crash.
- **AbortSignal**: best-effort interruption (the vm cannot be forcibly interrupted; `run` races the signal's abort promise and returns `error:{name:"AbortError"}` after abort). An infinite loop in vm cannot be truly stopped; the T2 tool-layer timeout and documentation constraints mitigate it, and this engine only guarantees the result is no longer used after abort.

## 6. Verification (T1 unit tests, pure, no browser)

`globalThis.x=1` persists to the next run; `reset()` removes `x`; top-level await (`return await Promise.resolve(42)` -> "42"); `nodeRepl.write("hi")` / `console.log("yo")` appear in logs; `throw new Error("boom")` -> `error.message "boom"` without throwing out; dynamic import (`await import("node:path")` -> `m.sep`); injectedGlobals (`{ping:()=>"pong"}`); addModuleDir accumulation; dispose idempotent.
