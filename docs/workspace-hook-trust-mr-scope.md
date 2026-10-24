# MR 2028 scope: Workspace Hook Trust v2 (feat/hook-trust-v2 -> staging)

Full history: git show 37b98ff8:docs/workspace-hook-trust-mr-scope.md (includes the per-module file/line statistics).

## 0. What this MR does

Workspace Hook Trust is a workspace-level hook trust/admission mechanism (soft gate). Attack chain it
addresses: external deep link -> open a malicious workspace -> a project-config `SessionStart` hook
runs a local command automatically. An earlier fix stripped project hooks from executable config
(always ignored); this MR builds the full trust system on top and restores project-hook usability:

- Project hook declarations are normalized into an immutable `HookBundleSnapshot`, with a
  `hookDeclarationDigest` per entry.
- Persistent Trust is keyed by `workspaceIdentity + hookDeclarationDigest` in the user-side trust store
  (`~/.zcode/security/workspace-hook-trust-v1.json`; a workspace file cannot self-grant trust).
- Soft gate: an untrusted hook does not block the turn. The turn skips it and reports
  `HookRunBlocked`; a pending banner appears at the chat bottom; the user trusts entries one by one in
  `Settings -> Hooks` ("trust" button). Trust applies only to future natural events; a skipped
  `SessionStart` is not re-run. A change in declaration semantics changes the digest and invalidates
  the old Trust.
- Managed policy deny wins; no capable host, a corrupt store and snapshot mismatch all fail closed.
- Headless/CLI uses `zcode hooks trust status|grant|revoke`.

Semantic authority spec: `docs/specs/workspace-hook-trust-persistent-only.md` (v2 keeps exactly one
authorization, per-entry persistent Trust of one exact declaration; v1's allow_once / trust_all /
keep_blocked polymorphic authorizations are removed).

## 1. Layers (original §1 layer diagram and §2 per-module detail, merged)

| Layer / module | Content |
| --- | --- |
| UI | Settings -> Hooks inline [trust] button and locked switch; pending banner; review store; reasonCode -> i18n mapping. `HooksSection`/`HooksList`: an untrusted row has a [trust] button and a locked-off Switch, no status badge, no bulk action. `useWorkspaceHookInlineTrust`: the RPC must route to the target workspace's host. `WorkspaceHookPendingBanner`: [review]/[dismiss]; dismiss is a renderer-local dismiss |
| Services | `hooksService` reads workspace config + trust store (full strict schema, same verdict as runtime/adapters; async ENOENT distinguished); workspace hook settings model (discovery -> UI rows); reports `trustStoreCorrupt` |
| Shared | v4 protocol projection `zcode-protocol-v4/workspace-hook-review` (decision/target/payload); snapshot/delta additive field `workspaceHookAdmission` (default null); discovery alignment; single-source store file schema `workspace-hook-trust-store-file.ts` |
| Bootstrap (`apps/zcode-cli`) | Sole production review entry `requestReview` (flow reuse / supervisor / serial queue / deadline wrap-up); workspace-level Settings pretrust RPC (no-session case; persisted after managed-policy check); `zcode hooks trust` CLI domain logic (status reports corrupt explicitly as `workspace_hooks_trust_store_corrupt`); v4 command wiring |
| Core | Trust domain (types/domain/records); `evaluateWorkspaceHookEntry` (`effectiveRunnable = admitted && configuredEnabled && policy != deny`); per-workspace coordinator (security revision, policy subscription); runtime admission (pending reported as `{pendingCount,bundleDigest,workspaceIdentity}`); runner soft gate emits `HookRunBlocked` (reasonCode `workspace_hooks_pending_trust`, does not block the turn) |
| Adapters | File trust store: atomic write (temp + fsync + rename, bounded Windows EPERM/EBUSY retry), file lock + stale cleanup, corrupt rename recovery (`*.corrupt-<ts>`), revoke rejects an empty array, compact |
| Contracts | Digest schema v1, review timeout, `WorkspaceHookTrustState` / admission class / reasonCode enums, effective-state schema, bundle snapshot schema, review flow state, policy schema (store file schema is now a shared re-export) |
| CLI | `zcode hooks trust status|review|grant|revoke` (`--workspace`/`--hook-digest`/`--all-current`/`--bundle-digest`/`--json`); human output includes grant guidance for pending and recovery guidance for corrupt |
| Desktop E2E | HK05-HK07 manual-review pending spec, fixture helper, wdio cold-start wiring, case-local provider fixture/manifest |
| Docs / scripts | Main spec `workspace-hook-trust.md`, `workspace-hook-trust-persistent-only.md`, soft-gate design `workspace-hook-trust-soft-gate.md`, user guide (with corrupt recovery), manual acceptance handbook, case catalog (HK05-07) + coverage matrix; `create-workspace-hook-trust-uat-fixture.mjs` generates a harmless UAT workspace (3 declarations + `executions.jsonl` recorder), `--verify` guards against drift; `pnpm-lock.yaml` (contracts gains the `@zcode/shared` workspace dependency); feature graph registration in `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` |

## 3. Key design decisions

1. **v2 = persistent-only** (`141ebf7bda`): delete v1's polymorphic authorization state machine
   (allow_once / trust_all / keep_blocked / timeout auto-decision / SessionStart re-run / standalone
   review panel); keep only per-entry exact persistent Trust. The decision contract narrows to
   `{ action: "trust_selected"; reviewItemIds }`.
2. **Single-source trust store schema** (CR-01): the schema lives in `@zcode/shared` (zod4); contracts
   re-export it (the zod3 side does not compose references); services/runtime/CLI judge the same file
   identically. JSON syntax errors and structural invalidity (missing schemaVersion/required fields,
   invalid decision/timestamp, unknown fields) are all corrupt and fail closed; under corrupt no
   `trusted_persistent` is shown.
3. **Soft-gate semantics**: an untrusted hook is skipped for the turn with `HookRunBlocked` (never
   disguised as `HookRunFailed`); the turn never waits for review; trust applies only to future
   natural events; banner dismiss is renderer-local (key = sessionId + bundleDigest) and produces no
   Trust mutation.
4. **`workspaceIdentity` isolation throughout**: trust key, review binding, pretrust RPC and cache
   dedup all use `workspaceIdentity` (local fallback `workspacePath`); a remote workspace must not
   become a local submission channel through the path fallback.

## 4. Verification state

| Layer | Evidence |
| --- | --- |
| Unit/integration | 2,800+ cases across contracts/core/adapters/bootstrap/cli/services/shared/ui, including CR-01 parity (9 red->green), corrupt-schema samples (12), review controller timing/concurrency/superseded |
| Desktop E2E | HK05-HK07 manual-review pending spec; macOS replay 3/3 passed (`desktop-e2e-20260817093717062-p95687-5fe4ae6a35334d65`, re-run after staging merge) |
| typecheck/lint | shared/services/contracts/bootstrap/cli + desktop all passed |
| Manual acceptance | `docs/testing/workspace-hook-trust-manual-acceptance.md` (UAT-01..05) + UAT fixture script |

Open follow-ups after merge:

- Windows: trust store rename retry, e2e Docker admit / CI sharding (`run-windows-e2e-shards.mjs`).
- After human review of the e2e spec, promote with `e2e:promote` to the formal directory and update matrix paths.
- Six pre-existing unit-test failures on upstream staging (appARMSBootstrap minified pattern / feedback base assertion / onRuntimeLifecycle mock) are unrelated to this MR and need a separate fix.

## 4.5 Companion v4 concurrency fix (review note)

One v4 change is in a different domain but logically coupled; it is declared for informed review:
turn-start uncertainty semantics in `prompt-turn.ts` / `queue.ts`.

- Adds a `turnStartUncertain` flag and the reasonCode `fault.command.turnStartProjectionCommitFailed`. In `queue.ts`, `sendQueuedNow` keeps the item promoting (does not roll back to queued) when promotion fails with an uncertain failure, because a late canonical TurnStarted concurrent with a retry would duplicate the message.
- Link to the soft gate: the soft gate requires that a turn never waits on review; the pending-hook skip path and turn start share one authority/projection commit order. Fixing the concurrency window exposed by injecting admission exceptions into that order is the same commit chain and cannot be stripped cleanly (it would need a history rewrite and rebase of all later commits).
- Review it as an independent concurrency-correctness fix: look at the `isPromptTurnStartUncertainFailure` branch in `queue.ts` (stays promoting) and the `isTurnStartAuthorityObserved` check in `prompt-turn.ts`.

`fork-edit-retry.ts`: earlier prettier-reflow noise with no semantic change was reverted to the staging version and is not in the MR diff.

## 5. Compatibility

- Protocol additions are additive (v4 snapshot/delta new fields default to null); old clients can ignore them.
- Users with an existing `zcode.json`/`.zcode/config.json`: after upgrade, project hooks change from "ignored by security policy" to "pending-trust soft gate"; the first visit to Settings shows the per-entry trust entry. The behavior change is expected and guided by the banner.
- Desktop continuous and mobile replayable: trust evaluation happens in the shared runtime/services layer; stream/snapshot/queue/owner semantics are unchanged. Mobile uses the same review RPC and the same trust store.
