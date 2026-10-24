# Todo 59: Default Model Selection and Remote Provisioning Failure Semantics Correction

> Status: implementation complete
>
> Date: 2026-09-01
>
> Prerequisite: Todo 55, 56 and 57 are complete. This Todo does not redo Provider Template, Environment-level sync
> or E2E infrastructure; it only corrects two implementation drifts confirmed in review.

## 0. Background and goal

To fix the E2E for late Account Registry publishing and stale Start Plan selections, Todo 57 added a special fallback
in Renderer draft initialization: "the current Account Provider's first model takes priority over the Host
`preferredSelection`". That rule bypassed the Configured Default, made the Renderer understand Account Family/Plan,
and lost the reasoning options carried by the Configured Default. Todo 56's first Remote Environment Provisioning had
become a sync barrier before the remote Workspace is published, but on receiving `failed`, `rollback_failed` or
`unsupported` it still only logged a warning and published the connection anyway, so a remote with critical model
config not synced would keep running on old or empty config.

Two sole rules: (1) the default selection of a new draft is provided uniformly by the target Host's
`preferredSelection`; Account Connection affects only Registry availability facts and creates no second default model
priority in the Renderer; (2) when the first Provisioning does not succeed the remote Workspace is not published;
after connection, later sync failures do not tear down the Workspace, only log a structured warning and retry on the
next formal trigger.

## 1. Model selection priority

### 1.1 Sole priority

```text
Task's explicitly inherited ModelSelection
  -> (none) valid Recent Selection under the current workspaceKey
  -> (none or invalid) target Host's preferredSelection: a valid Configured Default,
     else the first model of the first visible Provider in the Registry
```

The Renderer no longer reads or derives the current Account Provider and no longer lets `provider.models[0]` preempt
the Configured Default.

### 1.2 Responsibility boundary

- A Task/Draft explicit selection comes first (the user's intent in the current interaction context); Recent is used
  only while still valid in the current target Host's Selection View.
- Configured Default, Registry fallback and model option validity are resolved atomically by the target Host into
  `preferredSelection`.
- Account Config constrains only Account Provider entitlement, membership and access material and affects which
  selections remain valid indirectly through the Registry.
- The Renderer does not recognize Start Plan, Individual, Team, nor infer the default model from the Family
  Connection Selection.
- Together with Todo 58's Option Default retirement: at the standard Model Selection resolution boundary the target
  Host fills an ordinary missing reasoning with the ordered Enum's `values.at(-1)`; the Renderer consumes only the
  already complete `preferredSelection`; ModelFactory only validates and freezes concrete Options and no longer fills
  from the Model Config `default`.
- Newly written Draft, Recent, Session Selection and Configured Default must carry a concrete reasoning; any old
  sparse selection compat may normalize only at the Host's selection-persistence read boundary and must not spread
  fallback back into Renderer, Service, Model or Adapter.

### 1.3 Keep Registry revision re-hydration

Late Account Registry publishing is a real timing issue but needs no Account-first fallback: an early Selection View
publishes -> a blank Draft is prewarmed -> the Account Overlay completes and the Selection View revision updates ->
a Draft with explicit user model intent stays unchanged; a Draft without explicit user model intent is re-initialized
with the latest View. The existing revision-driven blank Draft rebuild is kept; with the Account-first branch removed
it ends up reading the latest Host `preferredSelection`.

### 1.4 Cleanup scope

Delete the `currentAccountProviderId` parameter and the Account Provider first-model branch of
`resolveDraftInitialModelSelection()`; delete the logic in `useDraftConfigControl()` that reads
`providerFamilyDomain` and `providerFamilyConnectionSelections` to derive a Provider ID for that branch; delete the
imports, memos, test constructions and comments serving only that branch; update Todo 57, the Selection Design and
E2E notes to state that the "recent -> Account first -> Host preferred" implementation record is superseded by this
Todo. The Provider Family Connection Selection product capability itself is kept; only its entry into generic Draft
default selection is forbidden.

## 2. Remote Provisioning failure semantics

### 2.1 The first connection is a strict barrier

Remote transport ready does not mean Remote Workspace ready; the first Provisioning must succeed before the Workspace
is published:

```text
Remote transport ready -> Environment 0 -> 1 registration -> first Provider Provisioning
 ├─ applied / already-applied -> publish Remote Workspace ready
 ├─ failed / rollback_failed  -> connection fails, show the real sync error
 └─ unsupported               -> connection fails, hint the remote version does not support model config sync
```

- `ProviderProvisioningExecutionResult` must not unconditionally `pending.resolve()` for all states: success states
  resolve the first-connection barrier; failure states reject/end the request through the existing Remote Workspace
  connection failure channel.
- The connection error keeps Environment, trigger and status; the Target's free text may come from any remote
  implementation and is not provably redacted, so it is not copied into Main logs or Renderer errors.
- `unsupported` is an explicit version/capability incompatibility, not a silent compat mode.
- No deadline is added: if the sync returns no result the connection stays pending so protocol or external I/O hangs
  are exposed directly; no timeout, sleep or automatic release masks state problems.

### 2.2 A post-connect sync failure does not tear down the Workspace

Provider save, Configured Default change, account state change and allowlist credential change trigger later syncs
for an already online Environment. A failure then only proves the remote model config did not catch up, not that the
SSH, WSL, Docker or Server file connection is invalid: success keeps the Workspace connected; failure / unsupported
also keeps the Workspace connected, logs an Environment-level structured warning and waits for the next formal trigger
to retry.

- A background sync failure never actively closes the existing Workspace, terminals or file operations.
- This automatic Provisioning is a temporary transition capability before independent remote config management
  launches: later failures go only to logs this round (no new Environment error state, protocol, Banner, Settings
  entry or second config authority). The warning carries Environment, trigger, status and duration so production logs
  can confirm the remote did not catch up; Target free text is not copied.
- When the current round fails with no new generation, no endless auto-retry; the next formal trigger re-reads the
  latest full snapshot; a user disconnecting and reconnecting re-enters the strict first-sync barrier.

## 3. Relation to existing design

Todo 56's Environment dedup, single-flight, trailing refresh, full-snapshot overwrite and Main-only scheduling stay.
Todo 56 section 5 ("failure or unsupported does not block the connection") is superseded by this Todo; Todo 57's
actual E2E evidence stays, but its Account-first fallback conclusion is superseded. The Provisioning Source reading
the Credential Store physical file directly stays an accepted v0 temporary coupling; no Credential export interface
is abstracted this round; empty Coordinator Environment lanes do not affect correctness and are not handled. No
change to Desktop `continuous`, Mobile `replayable`, owner/lease, CommandInbox or task recovery semantics.

## 4. Acceptance scenarios

### Model Selection unit tests

- A valid Recent beats Host preferred; an invalid Recent falls straight back to Host preferred without reading the
  current Account Provider; Host preferred keeps the Configured Default's reasoning options intact; without a
  Configured Default the Host's Registry fallback is used; an Account Selection change alone does not change the
  generic Renderer fallback; when the Selection View revision updates, a blank Draft without explicit intent
  re-hydrates and a Draft with an explicit selection is unaffected.

### Conversation E2E

- Fix I27/MP-R03 and I28/MP-R04: after an old Account model becomes invalid, return to the currently valid
  Configured Default; keep the late Account Registry publish scenario, proving that after the revision update the
  Draft uses the latest Host preferred; assert Provider, Model and reasoning options together (not only the toolbar
  text); do not restore the deleted selected-key/mode compat logic.

### Provisioning unit and integration tests

- First `applied`, `already-applied` publish Workspace ready; first `failed`, `rollback_failed`, `unsupported` never
  publish Workspace ready and return the error through the formal connection failure result; while the first sync is
  pending the connection stays pending with no timed release.
- A post-connect failure neither unregisters the Environment nor closes the Workspace and writes one Environment-level
  structured warning with no UI or persisted state; the next formal trigger retries, and success logs the usual
  success entry; a new generation during a sync still obeys single-flight + trailing refresh.
- Logs and error payloads contain no API key, OAuth token or full Credential value.

## 5. Docs and graph

Update `docs/working-memory/provider-refactor/design/interaction/selection-state.md` (delete Account-first default
selection, align with Todo 58's complete Selection semantics) and `docs/remote/provider-provisioning.md` (first
strict barrier and the degraded post-connect state); append "superseded later by Todo 59" pointers in Todo 56/57
implementation records without rewriting historical execution facts; update the I27/I28 expectations in the Provider
Refactor E2E analysis/coverage matrix. The Feature Graph already holds the Provider Template and Remote Provisioning
nodes; no failure-state UI is added so no new surface or state owner.

## 6. Completion gates and non-goals

No Account Provider default-selection special case in the Renderer; Configured Default is again the sole product
default fact after a Recent becomes invalid; a Registry revision update never overrides an explicitly chosen Draft;
the Remote Workspace is not published when the first Provisioning does not succeed; a post-connect sync failure does
not tear down the Workspace and leaves a structured warning without Secrets; no new Environment/Workspace error state
or UI, and the next real trigger retries; no second authority for default model, Registry Snapshot, Provider Config
or Credential; targeted tests and mandatory repo gates pass with real run evidence for relevant E2E.

Non-goals: Provider Family product structure changes; Remote Provisioning v1 two-way editing or remote management
UI; Credential Store/Keychain refactor; silent compat mode for old remotes; Coordinator empty-lane reclamation;
masking sync failures with timeout, retry storms or disconnecting an already connected Workspace.

## 7. Outcome (2026-09-01)

- Renderer's Account-first default selection and Family/Plan derivation are deleted; an invalid Recent falls back
  uniformly to the target Host's `preferredSelection`.
- The Selection View revision driven blank Draft re-hydration is kept; an existing explicit user selection is never
  overwritten.
- First Remote Environment Provisioning `failed`, `rollback_failed` and `unsupported` now reject the connection and do
  not publish the Renderer service port.
- A later sync failure of an already connected Environment keeps the Workspace online, logs only the structured
  warning (Environment, trigger, status, duration) and waits for the next real trigger; no Banner, protocol state or
  persisted error object; Target free text stays out of Main logs to avoid a credential leak surface in the temporary
  transition chain.
- Verification: Model Selection, Provisioning Coordinator and Remote Session directed tests passed; full unit, root
  typecheck, lint, Desktop E2E typecheck and changed-file mechanical checks passed with Todo 58 in the same round; the
  existing run evidence of related formal Provider/Remote E2E is kept; the new Settings graphical interaction case
  could not be actually run because the Linux display environment is blocked, and is not written as passed.
