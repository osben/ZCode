# Browser command contract + BrowserControlPort + protocol method spec (T3)

> Status: implemented.
> Parent: `2026-07-07-browser-use-cdp-node-repl-spec.md`.
> Scope: the `BrowserCommand` contract shared by agent / protocol / main, the agent-side `BrowserControlPort`, and the ZCode Protocol method `interaction/browserExecute`. Pure contract layer; broker, bridge and CDP are T4/T5.

## 1. Key fact: `@zcode/shared` is a single source

`apps/zcode-cli` is in the **root pnpm-workspace**, and the agent bootstrap's `@zcode/shared` resolves to the **root `packages/shared`** (the same package as the app). `BrowserCommand` and the protocol method are defined once in `packages/shared` and used by both agent and app, so the contract cannot drift.

## 2. BrowserCommand contract

- Location: `packages/shared/src/browser-use/commands.ts` (the `browserCommandSchema` discriminated union migrated from the old branch `feat/in-app-browser-use`).
- P0 core subset: `navigate/back/forward/reload/snapshot/click/type/screenshot/getState`. The old fill/press/scroll/waitFor/capabilities are migrated and kept; in P0 main implements only the core subset and the executor returns unsupported for the rest.
- Also migrated: `snapshot.ts` (`BrowserSnapshot` / element ref structure for the CDP AX tree output) and the result type `BrowserCommandResult`. `packages/shared/src/index.ts` exports `browser-use/*`.

## 3. Protocol method `interaction/browserExecute`

In `packages/shared/src/zcode-protocol/index.ts`:

- `zcodeProtocolMethods.interactionBrowserExecute: "interaction/browserExecute"` (under interaction/, an agent -> app reverse request, not a session method).
- Strict schemas and types:
  - `zcodeBrowserExecuteParamsSchema`: `requestId` (non-empty, correlation), `sessionId` (non-empty, zcode session), optional `turnId`, `command: zcodeBrowserCommandSchema`.
  - `zcodeBrowserExecuteResultSchema`: `ok: boolean`, optional `state` (BrowserPageState), optional `snapshot`, optional `image: { base64, mimeType: "image/png" }`, optional `error: { code, message }`, `elapsedMs >= 0`.
  - The protocol file historically keeps schemas self-contained; prefer importing `zcodeBrowserCommandSchema` from browser-use/commands. If it is declared separately, keep it isomorphic with a keep-in-sync comment and a round-trip test against drift.
- `zcodeProtocolSessionMethodContracts` gets `[interactionBrowserExecute]: { params, result }`.

## 4. BrowserControlPort (agent-side port)

- Location: `apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts`, exported from `interfaces/index.ts`.
- `execute(input: { sessionId: string; command: BrowserCommand; traceContext?: TraceContext; signal?: AbortSignal }): Promise<BrowserCommandResult>`.
- Types come from `@zcode/shared` (`import type`) if contracts depends on it; otherwise define mirror types in contracts plus a round-trip test.

## 5. Port injection chain (same route as `executionPort`)

- `ZCodeAppOptions` (`bootstrap/src/app/types.ts`) gets optional `browserControlPort?: BrowserControlPort`; when absent, `agent.browsers` reports unavailable.
- `create-app.ts` passes `options.browserControlPort` into the agent-runtime deps (like executionPort).
- `ToolExecutionContext` (`core/src/tool/types.ts`) gets `browserControlPort?`; `call-runner.ts` / `impl.ts` / `agent-runtime.ts` forward it when assembling the context.
- The T6 node_repl handler reads `context.browserControlPort` and feeds the browser-client `execute`.

## 6. Verification (T3 unit tests)

- `browserCommandSchema` parse/reject for every method, strict rejection of extra fields.
- `zcodeBrowserExecuteParamsSchema` / `ResultSchema` round-trip.
- Method table: `zcodeProtocolMethods.interactionBrowserExecute === "interaction/browserExecute"`; the contract table has the entry with zod schemas for params/result.
- If the protocol command schema and browser-use/commands are declared separately, a round-trip test proves both parse the same object identically.
- Typecheck: the whole chain compiles after adding the fields to ZCodeAppOptions / ToolExecutionContext.
