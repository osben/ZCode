# Prompt-cache prefix stability

Status: implemented, test-guarded. One rule (R5 for the LSP availability probe) is currently
violated; the reproduction is kept as `it.fails` in
`apps/zcode-cli/packages/core/tests/lsp-tool-registration-race.test.ts` (fix pending, see
"Known violation").

## Problem

Provider prompt caching (Anthropic-style `cacheControl: ephemeral`, and equivalent implicit
prefix caching elsewhere) keys on the byte-exact start of a request: the tools array followed by
the leading messages. Any unintended change between two requests of one session — a tool that
appears late, a segment that re-renders differently, a refreshed date — invalidates the cache and
re-bills and re-processes the whole prefix. Nothing pinned this property, so a refactor in the
context builder or the tool registry can silently break caching for every long session.

## Scope: the model-visible prefix

The guarantee is stated on the core `ModelRequest` produced by the runtime
(`prepareRuntimeProviderRequest`, `core/src/runtime/methods/turn-loop.ts`). The provider adapter
wire format (adjacent-user merging, wrapper tool names, per-provider schema rewrites) is out of
scope.

The **model-visible prefix** of a request is everything the model sees before the first user
conversation message:

- `ModelRequest.tools` — names, descriptions, input/output schemas, and order (registry `Map`
  insertion order, projected by `getTools`, `core/src/runtime/methods/config.ts:169-186`);
- every `role: "system"` message: CLI prefix, stable body, dynamic block
  (`core/src/context/builder.ts:271-317`);
- the meta-user system-reminder messages: `skills_listing` and `context_prefix`;
- the agent-listing reminder that the first request persists ahead of the conversation
  (`appendRuntimeAgentListing`, `core/src/runtime/helpers/agent-listing.ts`).

Everything else — per-request tail reminders (output style, todo, runtime mode, diagnostics,
date change) and the conversation itself — is the volatile tail and is exempt.

## Rules

**R1 — fixed segment order.** The prefix is emitted in one fixed order:

```
[0] system   CLI prefix                                  (no cacheControl)
[1] system   stable body (identity)                      (cacheControl: ephemeral)
[2] system   dynamic block (behavior, env, model line,
              output style, context management, git)      (cacheControl: ephemeral)
[3] meta-user skills_listing
[4] meta-user context_prefix (AGENTS.md + current date)
[5] agent-listing reminder (initial listing on the first request; persisted — later agent-listing
    deltas join the tail, never the prefix)
[k] first user conversation message ("conversation" begins here)
```

**R2 — byte-identical across requests.** Absent an allowed change, the prefix is byte-identical
for every model request in a session: same tools (JSON equality of names, descriptions, schemas,
order) and same prefix messages. The prefix is rebuilt from the same snapshot every model step
(`rebuildContextPrefix`, `core/src/runtime/methods/context-refresh.ts`, invoked from
`core/src/runtime/methods/turn.ts:421-424`), which is what makes this hold.

**R3 — per-turn content lives in the tail.** Anything that legitimately varies per request
(reminders, diagnostics, date change) is appended after the latest user input as system-reminder
attachments, never spliced into the prefix.

**R4 — volatile inputs are snapshotted at session start.** Environment info, git status, current
date, user/project instructions, the memory index, and the skills listing are captured once by
`ensureContextInitialized` (`core/src/runtime/methods/context.ts:41-96`) and reused verbatim for
every later prefix rebuild. A day rollover does **not** touch the prefix: the new date arrives as
a `date_change` tail reminder (`turn.ts:1233-1246`), driven by the runtime's injected `now`.

**R5 — the tool set is frozen unless allowed.** Tools are not added, removed, or reordered
mid-session except via the allowed-change list. Async capability probes must settle **before the
first model request** so late registration cannot mutate the tools array between requests.

### Allowed changes

| Change                              | Effect on the prefix                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/model` switch (Session Selection) | Only the dynamic block changes (`[2]`): the "You are powered by the model named …" line. `[0]` and `[1]` are unchanged.                                                                        |
| Language change                     | System text re-rendered (translation)                                                                                                                                                          |
| Output style change                 | Output-style section/reminder                                                                                                                                                                  |
| `systemPromptOverrides` change      | Stable/dynamic section text                                                                                                                                                                    |
| Dynamic-workflow activation         | Tool set grows by the workflow tools                                                                                                                                                           |
| MCP `list_changed`                  | Tools re-registered at the next turn boundary (logged as `mcp.tools.reregistered`). Kept deliberately — unlike Cindy, this fork lets MCP tool sets evolve mid-session, but only between turns. |
| Native ToolSearch exposure change   | `ToolSearch`/`DeferredToolCall`/catalog visibility                                                                                                                                             |
| Rewind / compaction                 | History is rewritten; the prefix restarts after it                                                                                                                                             |

## Review rule

PRs that touch `core/src/context/**`, `core/src/runtime/methods/context-refresh.ts`, the
tool/reminder assembly in `core/src/runtime/methods/turn-loop.ts`, `getTools`
(`core/src/runtime/methods/config.ts`), or `core/src/tool/registry.ts` must run
`apps/zcode-cli/packages/core/tests/prompt-cache-prefix-stability.test.ts` and state in the PR
description either "prefix unchanged" or the name of the allowed change that moved the prefix.

## Scenario tests

`apps/zcode-cli/packages/core/tests/prompt-cache-prefix-stability.test.ts` runs a full
`createTestAgentRuntime` with fixed context sources and a capturing model factory; `k` is the
index of the first message containing `turn-one`:

- **S1 — two plain turns:** exactly two model requests; tools JSON-equal; `messages.slice(0, k)`
  byte-identical (`k >= 4`).
- **S2 — day rollover:** the injected `now` advances across midnight between the turns. The
  prefix stays identical; request 2's **tail** carries the `date_change` reminder; the new date
  appears nowhere in the prefix.
- **S3 — model switch (negative control):** Session Selection changes before turn 2. System
  messages `[0]` and `[1]` stay equal; only the dynamic block `[2]` differs.

## Known violation: LSP late registration (R5)

`agent-runtime.ts:373` fires `void runtime.applyLspPreferences()` without awaiting it; the
availability check (`LspService.isAvailable` → `port.isInstalled`, `core/src/runtime/methods/lsp.ts:23-42`)
is async, so when it resolves slowly the LSP tool joins the registry after the first request was
already sent:

```
runtime constructed ──► void applyLspPreferences()  (isInstalled pending …)
turn 1 ────────────► request 1: tools WITHOUT LSP
isInstalled settles ─► LSP registered, cache invalidated
turn 2 ────────────► request 2: tools WITH LSP   ← prefix broken, cache invalidated
```

Reproduced by `apps/zcode-cli/packages/core/tests/lsp-tool-registration-race.test.ts`, marked
`it.fails` ("reproduces LSP late-registration race; fix pending") so the suite stays green. When
the fix lands (settle LSP availability before the first request, or expose the tool only from the
next turn boundary as an allowed change), the marker must be removed and the test must pass as a
plain `it`.

## Credit

The idea of a pinned, byte-stable model-visible prefix with an explicit allowed-change list is
adapted from Cindy (Apache-2.0), `docs/dev-rules/maker-core-and-agent-behavior.md`. Differences:
ZCode keeps MCP `list_changed` as an allowed mid-session change, and adds the day-rollover tail
reminder as the sanctioned way to refresh the date.
