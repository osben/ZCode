# Todo122: Preserve and Show the Specific Reason a Subagent Model Selection Fails

> Status (2026-09-11): implemented after this round's authorization with local review done; 84 Core tests and two browser
> detail/copy cases pass; whole-batch final acceptance was pending. The root cause of the unconfirmed on-site start
> failure is still outside this fix.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-122-subagent-selection-error-reason.md`

## Problem

`resolveSubagentSelection` threw every failure as `Select an available model before starting a subagent`, with the
specific reason only in `context.selectionIssue`. The public error projection reads `code`, `reason` and similar fields but
not `selectionIssue`, so the specific reason never reached the tool result and UI detail, and the parent model only saw a
generic configuration error. Offline runs of the real selection check and projection confirmed that account-connection
unavailable, Provider missing, model missing, level missing and level unsupported all ended with the same message and
`CONFIGURATION_ERROR`. The raw CLI `tool.call.failed` file log can still keep `error.context.selectionIssue`, so it is not
true that all logs lose it.

## Rules

```text
public selection resolution's actual failure reason -> Subagent error construction -> existing public error projection / tool result
  -> parent model, desktop and phone remote-control error display
```

1. Reuse the reason the public resolution already returns; the UI or error layer does not re-judge account, Provider,
   model or level availability.
2. Align with the existing error contract at the Subagent error construction: the stable reason goes into the existing
   `context.reason`, necessary identity into the existing Provider/Model fields; no tool-specific error protocol and no
   Subagent hardcoding in the generic error layer.
3. Users can tell apart: no model selected, current account connection unavailable, Provider unavailable, model missing /
   unavailable, no thinking level selected, thinking level unsupported. Copy is bilingual; the stable reason serves machine
   judgment (never parse display copy).
4. Foreground and background start failures both keep the reason; error detail and copied content do not regress to the
   single sentence, and the parent model's tool result also carries the specific reason, not only the UI.
5. Only facts available at failure time supplement the context, distinguishing original from effective selection (the
   original Provider is not passed off as a remapped execution Provider); no extra account query or model request; no Key,
   Header, config body or session text is output.
6. Failure conditions, effective-selection resolution, inheritance and internal override priority are unchanged: no
   automatic level, no parent-model fallback, no Provider replacement, no persisted-data change.
7. Spec and tool-change chain updated first; discriminating tests first; small-scope fix, no rewrite of the error system.

## Acceptance (done) and Review

All selection-failure reasons are covered with stable reason, readable information and necessary identity; normal explicit
selection, inheritance and internal override behavior unchanged; verified through the real public error projection and
tool-result chain (not just the thrown `Error.context`), foreground and background; UI interaction E2E for failure
notice, detail and copied content, covering desktop and phone remote control and both languages without changing the
real-time transport boundary (unexecuted verification recorded, not used to close); original logs still locate the
failure without leaking secrets, and no other model is started or selection written back after failure; related tests,
typecheck and lint in one batch.

Result: only the selection-error construction changed. Six public reasons enter the existing `context.reason` and a short
bilingual explanation enters the message (compatible with background paths that keep only the message); the original
selection is only labeled as selection and the effective identity comes only from the resolution result, not disguised as
an executed model. Resolution, inheritance, override, persistence, permissions and scheduling are untouched. Seven new
assertions were confirmed failing in the correct Core Vitest entry first; the six reasons are verified through the real
public projection / tool result / parent-model content, and the real foreground/background runner fails before start while
preserving the reason, with no model request. Five files / 84 tests pass. The real ToolLayout detail and copy pass in
browser cases (390 Chinese light, 1200 English dark); copy contains the stable reason and full identity. The fixture's tool
error is injected by the test (not a cross-process on-device fault); real phone shared-host/Electron untested; the
screenshots keep the three-line truncation while copy keeps the full text; missing Linux Chinese glyphs is not a font-visual
acceptance. Core typecheck, changed-file lint and architecture check pass; Core-wide lint still has existing oversized-file
errors that were not widened. Review confirms the public error and the background message consumers both keep the reason
and no Key/Header/config body is written.

## On-Site Investigation Background (Not Part of This Fix)

Report conditions: new version, local workspace; the built-in general-purpose showed GLM-5.3 / highest in the screenshot
yet start failed with the error above. The actual selection and `selectionIssue` at failure time on that machine were not
obtained, so no on-site root cause is declared. Two leads to verify: an existing Runtime did not read a Subagent config
saved later; a user/project profile of the same name overrides the built-in profile shown by settings (the project config
may also keep an unmigrated old Provider). If a Runtime was created after the save, the first does not explain the first
failure. Neither is treated as a confirmed bug here, and the config refresh policy is not reopened. The missing implicit
default level after migrating an old version is another conditional repro that cannot directly explain the current-version
"highest" screenshot; this item does not define or implement level backfill.

## Code Entries

`apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts`, `core/src/errors/error-payload.ts`,
`core/src/tool/executor/errors.ts`, `core/src/subagent/runner.ts`, `adapters/src/logging/serialize.ts`,
`packages/ui/src/ToolCallBlocks/ToolLayout.tsx`.
