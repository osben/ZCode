# Bugfix 03: Provider Review Boundary Closeout

> Status: Completed
>
> Date: 2026-08-27
>
> Source: per-commit review of the latest batch of Provider Refactor startup-recovery and settings-interaction bugfixes
>
> Related task: [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-03-provider-review-boundary-closeout.md`

## 0. Scope

Four boundary problems already adjudicated in review, without redesigning the Provider architecture:

1. Account fail-closed Overlay missed Off-Peak Providers on first resolve failure.
2. Max output tokens had two edit entries (simple input and full JSON) that could silently overwrite each other.
3. Configured Default corruption recovery deleted the file outside the file lock (cross-process race).
4. Host-to-CLI Account Overlay sync used the generic Provider Parser plus a hand-written gate instead of the
   Account Source schema.

Unchanged architecture:

```text
ZCode Built-in Provider Config -> Host Account Resolver -> Account Provider Overlay Snapshot @ revision
  --provider/updateAccountConfig--> CLI Account Source (local fact copy) -> Personal Provider Config
  -> CLI Effective Provider Registry
```

In Desktop-managed mode the Host owns the current account connection and plan facts; the CLI keeps a revisioned
Account Overlay copy to build its own Effective Registry and Active Model. The protocol sends no account
credentials, no full Registry, and the CLI does not re-query or re-parse account upstream facts.

## 1. Account fail-closed covers Off-Peak

Cause: `createFailClosedAccountProviderConfigSnapshot()` published `enabled=false` only for
`access.type = "zhipu-account"`; Off-Peak Providers use `access: { type: "zhipu-account"; family: "zai" | "bigmodel"; mode: "off-peak" }`
but have no explicit `enabled=false` in Built-in, and the Resolver treats a missing `enabled` as enabled, so they
stayed in the Registry and the Off-Peak Model Selection View.

Rule: when Account facts are unknown on first resolve and there is no Last Known Good Snapshot, every
Account-controlled Built-in Provider (`access.type === "zhipu-account"`) is explicitly disabled. Todo 26 unified
ordinary account and Off-Peak static identity as `zhipu-account` with `mode` distinguishing the product path; normal
Account Resolver and fail-closed share this one criterion (no old Access Type allow-list).

Acceptance: on first failure, Start, Individual, Team and both Off-Peak Providers are `enabled=false`; API Key and
Personal Providers still start; the Off-Peak Model Selection View excludes fail-closed Providers; a later
successful refresh atomically replaces the fail-closed Snapshot with a new revision; fixed Off-Peak Provider ID,
group, visibility and request-time auth contract are unchanged.

## 2. Max output tokens: single edit entry

1. The settings page removes the "max output tokens Option Spec JSON" editor and its Draft field. The underlying
   config stays: `optionSpecs.maxOutputTokens: { type: "limit"; max: number; default: number }`; `LimitOptionSpec`,
   Provider Schema, Effective Model Config, Model Options validation and Runtime use of `max/default` remain. The
   reasoning-tier Option Spec JSON and Reasoning Mapping JSON editors remain.
2. The "Max output tokens" input expresses the desired default `N`. The comparison base is `inheritedLimit`, the
   inherited `max` resolved with the current Personal `maxOutputTokens` slot excluded:

```text
N <= inheritedLimit  ->  max = inheritedLimit, default = N
N >  inheritedLimit  ->  max = N,              default = N
```

Example: inherited `max=32000, default=16000`; input 8000 -> `max=32000, default=8000`; input 64000 ->
`max=64000, default=64000`; then 8000 again -> `max=32000, default=8000` (never use the already-expanded
Effective `max` as the base). 3. Input is explicit Personal intent: even when `N` equals the inherited `default` it is saved as an explicit
Personal slot. Clearing the input deletes the slot and re-inherits; "restore all defaults" clears the model's
whole Personal Model Config Overlay at once. 4. The full Model Config must be able to resolve `inheritedLimit`; if missing, show an explicit validation error and
never guess from modelId, Provider type or constants.

Acceptance: one entry only; less/equal/greater inputs generate the full `LimitOptionSpec` as above; expand then
shrink restores inherited `max`; save, reopen and JSON round-trip do not drift; no JSON-over-number priority.

## 3. Configured Default recovery inside the lock

Configured Default is an Environment-level, rebuildable Model Selection preference
(`{ providerId: string; modelId: string; options?: ModelSelectionOptions }`), not Provider Config. A corrupt file
must not block Registry, Model Selection View or CLI startup; ignoring or deleting a confirmed-corrupt preference and
falling back to the Registry is correct.

Race: the old code caught all `withFileLock()` failures and deleted the file after leaving the lock, so process A
could delete a valid preference written by process B in between; lock failures, permission errors and temporary IO
errors were treated like corruption although they do not prove corrupt content.

Rule:

```text
withFileLock
  |- read ok: valid JSON/Schema -> return Selection
  |           confirmed corrupt -> delete inside the same lock, return undefined
  `- cannot lock / temporary IO failure -> do not delete; ignore preference this round, report recovery event
```

Deletion requires both "confirmed corrupt content" and "still holding the lock". No recovery backup is required
(rebuildable). A Legacy importer failure must not delete a formal file written later by another process.

Acceptance: invalid JSON/Schema/unsupported version does not block startup; lock failure, read permission error and
temporary IO error only fall back for this round; concurrent save and corruption recovery cannot delete a later
valid Selection; save/read keep the full structured `ModelSelection.options`.

## 4. Account sync uses the dedicated Source Schema

Host Account Resolver already turns login, plan and team results into the Account Provider Overlay. The CLI sync
entry does only physical schema validation and Snapshot replacement:

```text
Host Account Resolver -> Account ProviderConfigMap -> Protocol JSON Envelope
  -> CLI parseAccountProviderConfigMap() -> Mutable Account Source.replace(snapshot)
  -> generic Registry Resolver applies the Overlay
```

The sync entry must not: use the generic `parseProviderConfigMap()` plus a hand-written `access.type` gate;
re-implement the Account Connection Resolver; assemble Account Config from Provider ID, Family or Access Type;
query accounts, plans or credentials; accept `label`, `api`, `group`, `visibility`, `modelIds` or any field outside
the Account Source.

`parseProcessAccountProviderConfigSnapshot()` calls `parseAccountProviderConfigMap()` directly on `providers`. The
Account Source schema mechanically limits fields to `enabled`, account-constrained `builtinModelIds`, and
non-sensitive product/protocol Account Access facts. Off-Peak Account Overlay syncs only `enabled`. Public
`accessId` was removed in Todo 23/26; no substitute public credential reference is accepted.

Acceptance: Start, Individual, Team Overlays and `{ enabled }` Off-Peak Overlays round-trip across processes; sync
rejects API Key, Endpoint, Headers, label, group, visibility, Personal modelIds; no JWT, API Key, Team Key,
temporary Header or Credential Store key is in sync messages; Host and CLI use the same Snapshot revision.

## 5. Boundary with Todo 23

This Bugfix stands alone for the four items above. Todo 23 owns (not compensated here): removal of public
`accessId` (account credentials and connection version back in Account Service); Model edit as one atomic Host
Mutation; rename, membership, modelOrder and Personal Rule in one transaction; save failure keeps popup and Draft;
four-state Draft (Personal, Inherited, Effective Preview separated); Built-in simple editor vs Personal-only full
editor split; final cleanup of related Design, Feature Graph and old Todo facts.

## 6. Outcome

- Items 1 and 4 were completed by earlier commits.
- Item 3 is closed: confirmed JSON/Schema/version corruption is deleted inside the same lock; lock, read and Legacy
  importer failures only fall back for the round; regression tests cover invalid content and non-content read
  failures.
- Item 2 was completed with Todo 27: the full `maxOutputTokens` JSON editor and Draft field are removed, the single
  numeric input resolves `max=max(inherited.max,N)`, `default=N`, clearing re-inherits; tests cover less, equal,
  greater, expand-then-shrink.
- UI targeted tests and root `pnpm typecheck` passed; final lint, format and full regression evidence was recorded
  with the Todo 27 closeout.
- Completion also requires no second Account Resolver, Provider Parser, Model Config DTO or runtime model-specific
  branch.
