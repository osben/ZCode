# Todo 112: Normalize the Case of Official GLM Real Model IDs

> Status: Completed (2026-09-10): official ID normalization, incremental migration and rollback-boundary verification.
> Evidence, boundary review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-112-official-glm-model-id-normalization.md`

## 1. Goal and Boundaries

Unify the real `modelId` of official GLM models (not a display name or UI polish). Target style: `GLM-5.3`,
`GLM-5.3-Flash`, `GLM-5.2`, `GLM-5-Turbo`; new selections, saves and actual requests use the unified ID.

- Only Z.ai / BigModel official templates and official account model sources; no OpenRouter, OpenCode, MiniMax or other
  third-party/aggregator entries and no global rewriting of custom Provider model names.
- No quota cards, balance hints, plan promotional copy or their formatting functions.
- No new display-name field; no global case conversion in UI, generic Registry comparison or the request Adapter.
- No change to Provider ID, Access, protocol, Base URL, reasoning levels or model capability; model additions/removals
  belong to other Todos and ruled-deleted models are not restored under cover of case cleanup.

## 2. Where Changes Are Required

### 2.1 Official Templates: List and Exact Rules Together

In `config/provider/zcode-builtin.json`, `zai-api` and `bigmodel-api` each had 21 lowercase GLM members (42 GLM
`templateModelRules` in total). Change both templates' `builtinModelIds` and the corresponding
`templateModelRules[].modelId` (strictly matched; changing only the list is not enough), e.g. `glm-5.3` -> `GLM-5.3`,
`glm-5.3-flash` -> `GLM-5.3-Flash`, `glm-5-turbo` -> `GLM-5-Turbo`. Target spellings cover all other GLM models including
FlashX, Air, vision and date suffixes; never a blanket `toUpperCase()`, and never change version numbers, separators or
drop suffixes. The list/rules follow the Todo111 four-template split (update the official ordinary API / Coding Plan API
lists and exact rules by final template identity, without reintroducing old templates or renaming twice).

### 2.2 Start: Normalize at the Official Model-List Entry

`packages/services/src/model-provider/zaiStartPlanBilling.ts` `resolveZaiStartPlanBalanceModelIds()` extracts
`model:<id>` from the balance `capabilities` (falling back to `show_name`), deduplicating case-insensitively but keeping
the original spelling. `codingPlanProviderAvailability.ts` passes the result to account resolution and
`packages/provider/src/account-provider-resolution.ts` replaces Start's static `builtinModelIds` with it, so editing only
the Built-in JSON would still show lowercase after refresh.

```text
official Start balance response (data unchanged) -> extract capability model IDs -> normalize known official GLM IDs, dedupe
  -> Account Provider model list -> Registry / model selection -> saves and actual requests use the normalized real ID
```

- Known GLM IDs get their target spelling at that official list boundary; unknown models stay as-is; the balance response
  is not rewritten and normalization does not spread to other Providers or quota display.
- Entitlement, empty-list, pending and dedup semantics are kept; the mapping never adds models the server did not grant.
- Personal/team and off-peak account static lists already use the uppercase style (check consistency only); bound
  off-peak Tickets, fixed executions and their model identity are untouched.

### 2.3 Public Consumption Chain Unchanged

`packages/provider/src/config/model-config.ts` recommendation-rule `modelMatch` already ignores case (no rewrite of
generic rules; template/Provider exact rules stay strict). `effective-model-selection.ts`, model validation and Registry
keep exact identity comparison and are not loosened for all vendors. Settings lists and chat / automation / Subagent /
Wiki share Registry / Selection View results with no per-place display conversion; drafts, save timing and persistence
ownership are unchanged. The Adapter passes the bound `modelId` to the SDK as-is, with no "display uppercase, send
lowercase" bypass.

## 3. Compatibility Boundary

### 3.1 Existing Lowercase Selections and Personal Overrides

Old lowercase Selections, personal exact model overrides, personal members and ordering do not update automatically when
Built-in is renamed; with strict matching they may become invalid or ineffective. Todo111's "no migration" applies only to
the two unused templates, not to all Start history selections and user personal config.

User supplement: at existing selection-migration entries, old model IDs that clearly belong to official GLM are
case-normalized by the rename table fixed this round, for robustness; not extended to third-party or custom Providers or
generic runtime matching, and no new migration system. Personal exact overrides / members / ordering migration is not
extended and is not a pending item. Historical messages' actual execution models and usage statistics are never rewritten
by the new naming, and running executions neither recall nor switch models.

### 3.2 Official Endpoint Acceptance

Changing the real ID changes the request `model`. The user confirmed that the official endpoints accept the target case
this round; this is the implementation premise and online proof is not a start/finish gate. Implementation still verifies
that list, exact rules, migration results and final request ID agree, without a display-name scheme or runtime
lowercasing. This evidence is user confirmation, not claimed verified by a real request; contrary real evidence would be
recorded as a concrete problem.

## 4. Implementation, Tests and Completion

Landing supplement: Todo109 froze database conversions in checksummed migrations whose history cannot be edited. Agent
`0021` / App `0003` are appended through the existing database-level mechanism and change only
`session_entry` current `runtime/model_selection.modelSelection.modelId` and `automations.model_selection.modelId`. Only
clearly official account IDs are accepted; Personal IDs, historical message/part, `automation_runs`, `session_input`,
off-peak Tickets, old fields and timestamps are untouched. The migration SQL uses frozen constants, not the live
recommendation catalog. Non-database legacy Subagent / Bot / Wiki imports apply the same known-ID normalization at their
existing migration entries.

Exact spelling table (case only; versions, separators and digits unchanged): `GLM-5.3`, `GLM-5.3-Flash`,
`GLM-5V-Turbo`, `GLM-5.2`, `GLM-5.1`, `GLM-5.1-Highspeed`, `GLM-5`, `GLM-5-Turbo`, `GLM-4.7`, `GLM-4.7-FlashX`,
`GLM-4.7-Flash`, `GLM-4.6`, `GLM-4.5-Air`, `GLM-4.5`, `GLM-4.6V`, `GLM-4.6V-Flash`, `GLM-4.6V-FlashX`,
`GLM-4.1V-Thinking-FlashX`, `GLM-4.1V-Thinking-Flash`, `GLM-4-FlashX-250414`, `GLM-4-Flash-250414`, `GLM-4V-Flash`.
Ordinary templates `zai-standard-api` / `bigmodel-standard-api` use the original wide catalog; plan templates `zai-api` /
`bigmodel-api` keep only the two models confirmed by Todo111. Non-GLM members stay as-is; unknown GLM spellings are not guessed.

Acceptance (all done): spec updated with the exact rename table and final template ownership; discriminating tests first
for list / exact rules and the Start list entry (case variants, duplicates, unknown models, empty list, capability set not
widened); official template members and exact rules correspond with enable/capability/reasoning config unchanged and
third-party same-name GLM, custom models and non-GLM unchanged; public selection stays exact and personal overrides /
old selections handled per the final ruling with no change to historical messages / usage statistics and no new Selection
execution bypass; targeted interaction E2E confirms official settings / model selection show the real ID and the actual
binding and wire use the same ID, local and remote reuse the original delivery chain and the continuous / replayable
boundaries are unchanged; whole-batch unit tests, typecheck, lint and request-ID assertions; review of every rename
destination, the official scope limit and the Todo111 intersection. No auto-push. No open ruling remains.

## 5. Investigation Note

Static checks (config enumeration and exact references) via the feature-boundary-planner impact-only mode; no codegraph
tool; tests were not run at investigation time. Suggested for the feature graph: add "official Start model-list
normalization" to the Registry source relations (not done). The investigation is not on-device proof of endpoint case
compatibility.
