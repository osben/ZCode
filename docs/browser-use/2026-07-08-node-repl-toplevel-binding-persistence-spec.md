# node_repl top-level binding persistence across calls (route B, A-ready seam)

Date: 2026-07-08. Status: implemented (route B; commits 9c5472724 T1 / ae5742031 T2 / 69336b1b1 T3; core tests pass).

## 1. Background and goal

A real-machine trace reproduced: the model wrote `const tab = await agent.browsers.open(...)` and a later `js` call referencing `tab` threw `ReferenceError: tab is not defined`. Root cause: to support top-level await, `NodeReplSession.run` wraps code in `(async () => { ... })()`, so top-level `const/let/var/function` are captured by the IIFE's local scope and never reach the persistent vm context; only `globalThis.x =` survives across calls.

The full approach (route A): parse with `meriyah.parseModule` -> instrument top-level declarations -> run in a persistent `vm.createContext` as a `vm.SourceTextModule` (native ESM TLA, needs `--experimental-vm-modules`) -> harvest bindings from `module.namespace`.

Goal: let `const tab = ...` be reused across `js` calls. **Route B (no `--experimental-vm-modules`)** keeps the async IIFE for TLA and uses a parser to instrument top-level declarations into "copy to the persistent context", leaving a seam so a later upgrade to route A is cheap. A is not first because `vm.SourceTextModule` needs the flag, and the packaged agent runs under `ELECTRON_RUN_AS_NODE` where adding the flag is unverified; B needs no flag, is low risk and is the stable fallback.

## 2. Route B mechanism

For each `js` call:

1. **Parse** with `meriyah` (ESTree; `ecmaVersion:"latest"`, `allowAwaitOutsideFunction:true`, `allowReturnOutsideFunction:true`). On parse failure fall back to running the code wrapped in the async IIFE as before (instrumentation must not crash the call).
2. **Collect top-level binding names**: walk `ast.body` for `VariableDeclaration` / `FunctionDeclaration` / `ClassDeclaration`, including destructuring (ObjectPattern / ArrayPattern / RestElement / AssignmentPattern). `for` / `for-of` init/left are not handled (loop-local; A can complete them).
3. **Instrument**: after each top-level declaration statement inject `globalThis.<name> = <name>;` per name, written to avoid collisions.
4. **Wrap and run**: `(async () => {\n<instrumented code>\n})()` via `runInContext` on the persistent context (unchanged). In the next call a bare `tab` resolves through the scope chain to `globalThis.tab`.

Semantic differences from route A (acceptable): A keeps real `const` TDZ and "redeclaration across calls errors"; in B a same-name `const` in a new call's IIFE is a new local that **shadows** the global without error (more lenient, harmless to the model; A later gives stricter semantics). Only top-level declarations persist; block- and function-level ones do not.

## 3. A-ready seam (B -> A swaps the executor only)

New pure functions in `packages/core/src/repl/instrument.ts`, unit-testable alone:

- `parseReplCode(code): { ast } | { parseError }` wraps `meriyah.parseModule` (swapping parsers touches only this).
- `collectTopLevelBindingNames(ast): string[]` collects top-level declarations plus destructuring; **A reuses it directly**.
- `instrumentForContextPersistence(code, ast): string` is B's rewrite (injects globalThis assignments); A adds `instrumentForModuleHarvest` reusing `collectTopLevelBindingNames`.

`NodeReplSession` hides "execute + persist" behind `interface ReplExecutor { run(code, context, signal?): Promise<{ result?, error? }> }`. B implements `IifeContextExecutor` (instrument -> async IIFE -> runInContext); A would implement `SourceTextModuleExecutor` (harvest-style instrument -> SourceTextModule.evaluate -> harvest namespace). `NodeReplSession.run()` calls only `this.executor.run(...)`.

## 4. Dependency

`apps/zcode-cli/packages/core` adds `meriyah` (zero dependencies, ESTree compatible, bundled by tsup).

## 5. Tasks (TDD)

- **T1**: `instrument.ts` three pure functions + tests: `collectTopLevelBindingNames` covers `const a`, `let a,b`, `var`, destructuring `const {x,y}=o` / `const [p,[q]]=arr` / rest, `function f(){}`, `class C{}`, and ignores block/function-level declarations; `instrumentForContextPersistence` asserts injected `globalThis.a=a` etc.; the parse-failure path.
- **T2**: `ReplExecutor` + `IifeContextExecutor`; `NodeReplSession.run` goes through the executor. Tests: `const tab=1` in call 1 -> `tab` readable in call 2; destructuring persists; top-level await still works; block-level `const` does not persist; parse failure falls back and still runs; reset clears.
- **T3**: documentation rollback: `documentation()` and the `js` tool description demonstrate `const tab = await agent.browsers.open(url)` again (usable across calls), dropping the "use globalThis" transition note.

## 6. Affected files

New `apps/zcode-cli/packages/core/src/repl/instrument.ts` + tests; changed `.../repl/node-repl-session.ts` (executor seam), `.../browser-client/facade.ts` (documentation const demo), `.../tool/handlers/node-repl.ts` (js description), `apps/zcode-cli/packages/core/package.json` (meriyah).
