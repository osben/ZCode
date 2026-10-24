# Workspace Hook Persistent Trust Simplification Spec

> Status: product semantics confirmed 2026-08-13; the latest source of truth for the Workspace Hook Trust interaction and state model. It supersedes `Allow once`, `Keep blocked`, `trust_all`, SessionStart catch-up and multi-state badges in older docs.

## 1. Goal

Workspace Hook keeps exactly one user authorization: persistent trust of one exact Hook declaration in the current workspace.

- The config toggle only controls whether a Hook is enabled.
- The "Trust" button only creates persistent Trust and never flips the config; its visibility comes from the static Settings Trust snapshot, not from whether a Runtime review flow currently exists.
- Trusted hooks show no button and no "trusted" badge.
- Untrusted hooks show no derived states such as "needs review", "not persistently trusted", "will run / will not run".
- No Workspace Hook specific one-time grant, trust-all, or session-block action exists.
- Generic tool-permission `Allow once` is a different feature and unaffected.

## 2. Impact Brief

### 2.1 Changed layers

| Layer         | Change                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| presentation  | Removed the standalone review panel and inline status badges; an untrusted row always shows a "Trust" button left of the effective-run toggle                                                          |
| validation    | Still validates workspace identity, bundle digest, review flow generation, interaction and review item; also validates the same trusted managed policy provider before every Settings Trust mutation     |
| commit-effect | The user can only submit a persistent Trust mutation for a single or explicitly selected item                                                                                                           |
| persistence   | Still the user-owned Trust store keyed by `workspaceIdentity + hookDeclarationDigest`                                                                                                                   |
| recovery      | continuous/replayable keep projecting pending admission; timeout, disconnect and page close never write Trust                                                                                           |

### 2.2 UI Surface Matrix

- Settings / Hooks / Workspace row. Display / local state: Hook config and the static Trust store snapshot decide button/toggle display; an active review request only supplies an actionable generation; Submit entry: With a session command binding reuse Runtime review; without task/session, revalidate the snapshot via the workspace-level Agent RPC, pass the same Host-injected managed policy provider, then submit the exact declaration digest; Authoritative state: Runtime review controller / workspace pretrust authority + shared managed policy provider + user Trust store; Multi-client boundary: Desktop and Web share the component; remote must carry `workspaceIdentity` / `remoteSessionId`; no hidden task may be created to trust.
- Session pending banner. Display / local state: `workspaceHookAdmission.pendingCount`; Submit entry: `requestWorkspaceHookReview`, then open Hooks settings; Authoritative state: Runtime admission projection; Multi-client boundary: Desktop continuous pushes directly; Web remote replayable recovers from snapshot.
- Runtime dispatch gate. Display / local state: canonical snapshot evaluation; Submit entry: No UI bypass; Authoritative state: Trust coordinator + security revision; Multi-client boundary: All SessionStart/tool dispatch shares one gate.

### 2.3 Relationships to inspect

- `must-inspect`: shared protocol decision schema, review controller, Trust coordinator, Hooks Settings row component, i18n and related tests.
- `should-inspect`: pending banner, continuous/replayable projection, Trust store, policy, revoke and digest changes.
- `invariant-only`: generic tool permission `Allow once`, provider execution boundary, desktop queue and mobile replayable queue.
- `evidence-only`: the old review panel, once-grant/session-family tests and UAT copy; they prove cleanup completeness and no longer define product behavior.

The code-graph service was unavailable; impact was cross-checked with the repo feature graph, `dep:refs`, protocol call chains and exact text references. The previously missing Workspace Hook Trust capability, Settings surface, renderer binding, Runtime controller and Trust store relationships were added to the feature graph.

## 3. State Model

Only two user-visible trust states exist:

```text
                         Hook declaration digest changes
                    ┌──────────────────────────────────┐
                    │                                  v
               ┌──────────┐      click "Trust"   ┌──────────┐
               │ untrusted│ ────────────────────> │ trusted  │
               └──────────┘  exact check + atomic └──────────┘
                    ^             persist              │
                    └──────────── exact revoke ────────┘
```

Config state is orthogonal to trust state:

| configured | trusted | Inline action                                                                          | Runtime result                                  |
| ---------- | ------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| off        | no      | "Trust" plus a locked-off effective-run toggle                                         | Does not run                                    |
| on         | no      | "Trust" plus a locked-off effective-run toggle; the raw config is not rewritten        | Skipped and reported as pending                 |
| off        | yes     | Only the off config toggle                                                             | Does not run                                    |
| on         | yes     | Only the on config toggle                                                              | Runs after other policy / snapshot gates pass   |

When untrusted, the toggle shows "can it run now", so it is uniformly off and inoperable; the raw `configuredEnabled` stays in the workspace config. If it was `on`, persistent trust plus a Settings refresh turns the toggle on again; if `off`, it stays off but becomes operable. Opening Settings, showing the locked toggle or starting Trust never silently rewrites workspace config for UI effect.

`blocked_policy`, a corrupt Trust store etc. remain Runtime security reasons but are not disguised as user trust choices and get no product badge on the Hook row. When policy forbids user Trust writes, the server must reject the "Trust" action and show a readable error.

## 4. User Interaction

```text
A session discovers an enabled + untrusted Hook, or Settings statically discovers any untrusted Hook
  -> Runtime natural events still skip the Hook; the turn continues
  -> the user enters Hooks settings via the pending banner or on their own
  -> static Trust state immediately shows "Trust" and the locked-off effective-run toggle
  -> click prefers reusing the current session review flow
  -> with no task/session, rediscover the canonical snapshot via a workspace-level read-only Agent RPC
  -> validate mutation authority with the same trusted managed policy provider as the session Runtime
  -> only user_decides continues; deny / allow_trusted_only return a stable reason code and write no store
  -> submit the row after matching workspaceIdentity + bundleDigest + hookDeclarationDigest
  -> Runtime validates the immutable generation and the current bundle
  -> Trust store persists atomically, security revision increments
  -> list refreshes; that row's "Trust" button disappears
  -> other untrusted rows keep their buttons
```

1. The button is disabled while a mutation is in flight (no double submit); on failure the button stays and a localized error shows.
2. The row itself can still enter edit; button clicks must stop propagation so they never open the edit form.
3. Without an active session command binding the button still shows and works: the Hooks service only forwards the request to the workspace-level Agent Trust authority and never writes the Trust store itself. This entry never creates a hidden task and never treats the static Settings snapshot as authorization; the Agent rediscovers and exactly compares the canonical bundle before submitting.

## 5. Timing and Lifecycle

- Trust applies only to future natural Hook events; already skipped events are not retroactively run.
- A skipped `SessionStart` is not re-run on the 2nd/3rd prompt of the current task; it runs at the earliest on the next real SessionStart (new task/session).
- The review deadline only expires the immutable request and closes the current operation snapshot; it writes no negative decision and does not clear pending admission.
- Page close, leaving Settings, attachment disconnect and banner dismiss never change Trust.
- After partial trust, the succeeded item's button disappears; if pending items remain, Runtime publishes a new generation and the other buttons stay usable.

```text
Renderer              V4/Bootstrap                 Core / Trust Store
   │ click "Trust" on untrusted row │                      │
   ├─ session exists: request review ─> open/reuse flow    │
   ├─ no session: workspace grant ─> rediscover snapshot   │
   ├─ exact item decision ─>│ validate identity/bundle/flow│
   │                        ├─────────────────────────────>│ atomic grant
   │                        │<─────────────────────────────┤ revision + evaluation
   │<─ settled old flow ────┤                              │
   │<─ requested next flow ─┤ (only if still pending)      │
   │ refresh Hooks list     │                              │
   │ button disappears per persistent Trust                │
```

## 6. Protocol and Domain Convergence

`WorkspaceHookReviewDecision` keeps only:

```ts
{
  action: "trust_selected";
  reviewItemIds: string[];
}
```

Removed Workspace Hook specific: the `allow_once` / `trust_all` / `keep_blocked` decisions; `WorkspaceHookOnceGrant`, the once grant map and `trusted_once`; session-family user block and `blocked_user`; timeout auto user decisions; SessionStart lazy catch-up; the standalone review panel, select-all/multi-select controls, multi-state badges and their i18n/test-id/telemetry branches.

Exact revoke stays as a lower-level and other-entry capability; the Hook list shows no revoke button.

## 7. Invariants

1. A declaration without persistent trust does not run at any dispatch entry.
2. A Trust mutation binds `workspaceKey = workspaceIdentity?.trim() || workspacePath` and the exact declaration digest.
3. A remote workspace never degrades to a `workspacePath`-only check.
4. Stale generation, bundle change, item outside the snapshot and policy denial all fail closed. Settings no-session pretrust and session review read the same Host-injected `WorkspaceHookPolicyProvider`: `deny` returns `workspace_hooks_blocked_by_policy`, `allow_trusted_only` returns `workspace_hooks_policy_requires_pretrust`, and neither calls a Trust store mutation. UI or workspace/project config must not supply or override that provider.
5. The Trust store lives in user-owned storage; workspace files cannot self-grant trust.
6. Desktop continuous does not splice mobile replayable recovery messages; mobile replayable does not bypass snapshot/gap/owner boundaries.
7. UI never calls a Repo directly; Settings submits through the existing command/service boundary.

## 8. Case Planning and Pruning

### Confirmed cases

- **WHT01**: Setup: enabled + untrusted; Action: Open Hooks settings; Assertions: Only "Trust" and the toggle, no status badge; Evidence: UI + Runtime request item.
- **WHT02**: Setup: disabled + untrusted, current immutable review exists; Action: Click "Trust"; Assertions: May pre-trust persistently; config stays off; button disappears; Evidence: UI + Trust store.
- **WHT03**: Setup: multiple untrusted; Action: Trust one; Assertions: Only that one persists/disappears; the rest stay operable via the next generation; Evidence: Protocol + store + UI.
- **WHT04**: Setup: a trusted SessionStart was previously skipped; Action: Send another prompt in the current task; Assertions: Not re-run; the next new task's natural SessionStart may run it; Evidence: Runtime lifecycle.
- **WHT05**: Setup: pending review; Action: Timeout / close / disconnect; Assertions: Trust unchanged, pending admission unchanged, review can be requested again; Evidence: Protocol projection + store.
- **WHT06**: Setup: a trusted declaration changes semantically; Action: Refresh / next evaluation; Assertions: New digest is untrusted, button reappears, the old record does not authorize the new declaration; Evidence: Digest + UI + runtime gate.
- **WHT07**: Setup: local and remote tabs share `workspacePath`, remote has its own identity; Action: Local Settings looks up review/command binding; Assertions: Only the local binding matches; a remote identity cannot become a local submit channel via path fallback; Evidence: UI store.
- **WHT08**: Setup: explicit project config and auto-discovery point to the same file, or a candidate has corrupt JSON; Action: Runtime and Settings each build a snapshot; Assertions: The same canonical source appears once; a failed candidate still occupies discovery order; both sides' digests agree; Evidence: adapters + shared discovery.
- **WHT09**: Setup: pending banner visible; Action: Click "dismiss"; then bundle digest changes; Assertions: Current bundle hides immediately; the new bundle shows again; a command reject only logs via services/UI standard logging; Evidence: UI interaction.
- **WHT10**: Setup: same snapshot requests review repeatedly, or concurrently submits the same decision twice; Action: `requestReview` / `respond`; Assertions: The flow is created and supervised once; Trust persists once; the second submit is superseded; Evidence: bootstrap controller.
- **WHT11**: Setup: Trust atomically persisted but the deadline ends the old flow first; Action: controller settles the submit result; Assertions: Reported as accepted with exactly one resolved Settled; a successful grant is never misreported as failure; Evidence: bootstrap controller + store.
- **WHT12**: Setup: Trust store revoke receives an empty digest list; Windows rename hits a brief lock; Action: revoke / atomic write; Assertions: Empty list rejected as invalid; `undefined` still revokes all of the workspace; EPERM/EBUSY/EACCES retried with a bound; Evidence: adapters persistence.
- **WHT13**: Setup: Settings static snapshot untrusted, no current review interaction, a same-workspace session command binding exists; Action: Open Workspace Hooks; click "Trust"; Assertions: Button immediately visible; toggle off and locked; first request review, then submit persistent Trust once the same-bundle immutable request containing that item arrives; Evidence: UI store + bootstrap controller.
- **WHT14**: Setup: only a configured-disabled + untrusted Hook exists, or no session command binding; Action: Request review / open Settings; Assertions: The controller may build a flow for a disabled pending item; without a command binding the button is still clickable and persists trust via workspace grant; no display rewrites workspace config; Evidence: UI + bootstrap controller + services/Agent RPC.
- **WHT15**: Setup: no task/session; the Settings snapshot is stale or the Trust store is corrupt at click time; Action: Click "Trust"; Assertions: The Agent rediscovers the snapshot; bundle/digest mismatch or a corrupt store fails closed, writes no Trust, creates no task; Evidence: shared protocol + bootstrap pretrust + UI.
- **WHT16**: Setup: no task/session; Host managed policy is `user_decides` / `deny` / `allow_trusted_only`; Action: Click "Trust" in Settings; Assertions: Only `user_decides` enters the exact grant; `deny` returns `workspace_hooks_blocked_by_policy`; `allow_trusted_only` returns `workspace_hooks_policy_requires_pretrust`; the latter two never call the store grant and leave no record that would take effect if policy later relaxes; Evidence: protocol server + shared policy provider + Trust store spy.

### Pruning

- `allow once × session family × restart`: removed from the product, not enumerated.
- `keep blocked × timeout × dismiss`: all normalize to "no Trust mutation"; no negative-decision permutations.
- `trust all × configured enabled`: the standalone action is removed; bulk selection is outside the minimal UI.
- `trusted badge × will run badge × configured badge`: derived displays removed to avoid combinatorial explosion and wrong promises.
- Theme/locale/client mode are not crossed with security states; UI unit tests cover Chinese/English and theme tokens, and shared projection tests cover the continuous/replayable boundary.

## 9. Verification

- Shared/contracts: the decision schema accepts only `trust_selected`; old actions are rejected.
- Core: admission by persistent Trust only; no once/user-block/catch-up state.
- Bootstrap: after a single trust the old flow settles and a next generation is published for the remaining pending items; timeout writes no state.
- UI: button visibility is decided by static untrusted state; with a session it requests on demand and waits for the exact immutable request, without a session it revalidates and persists trust via the workspace Agent RPC; the untrusted toggle is off and locked per effective run state; the button disappears after refresh on success; status badges and the old panel do not render.
- Regression: real CLI desktop-agent build, `pnpm typecheck`, `pnpm lint`, targeted Trust tests, provider refactor tests.

## 10. Review-Fix Invariants

Implementation constraints from the 2026-08-13 review; they fix isolation, determinism and reliability only and add no product states.

1. When the Renderer looks up a review/command binding it first computes the current `workspaceKey`. A binding with a non-empty `workspaceIdentity` must strictly equal that key; only a local binding without its own identity may fall back to `workspacePath`. A remote tab with the same path never becomes a submit channel for the local "Trust" button.
2. Runtime and Settings share the candidate numbering and canonical-path de-duplication of `discoverWorkspaceHookConfigPaths`. An explicit path may not bypass it by being appended separately; a candidate that fails to load still occupies discovery order so later declaration digests do not shift.
3. Pending banner dismiss is renderer-local, non-persistent state, but a click must re-render the component immediately; the key stays `sessionId + bundleDigest`, so a bundle change naturally restores the prompt.
4. The controller's only production entry is `requestReview`. Repeated requests for the same pending flow reuse the flow and supervisor; concurrent mutations are serialized by the controller queue. Once the Trust store committed, even if the deadline prevents the old flow from resolving again, the result settles as authorization success and resolved Settled is sent once.
5. Trust store revoke keeps a strict tri-state: `undefined` revokes all records of the workspace; a non-empty array revokes exact digests; an empty array is a caller error rejected before any IO. The atomic rename retries Windows `EPERM` / `EBUSY` / `EACCES` brief locks asynchronously with a bound; other errors return immediately.
6. Workspace Hook review no longer connects to the generic interaction broker or the parked-turn dual-ACK failure chain. Shared protocol keeps only the schemas/types still consumed by command envelope, core flow and task realtime.
7. Static Settings Trust state decides display only and is never mutation authority. With a session binding, the inline Trust must wait for an immutable request with the same workspace identity, the same bundle digest and the target reviewItemId. Without one it must rediscover the canonical snapshot via the workspace Agent RPC and match the same workspace identity, bundle digest and declaration digest. Timeout, disconnect or bundle change on either path fails closed.
8. Whether `requestReview` has pending items must not be filtered by `configuredEnabled`. Config toggle and Trust are orthogonal: a disabled declaration may be pre-trusted but still does not run; the locked display of the untrusted toggle must not rewrite config files.
9. The workspace pretrust protocol `reasonCode` is an explicit enum and must not carry the underlying `Error.message`. Known public domain reasons pass through exactly; exceptions containing absolute paths, usernames, config content or arbitrary unknown text all map to `workspace_hooks_config_unreadable`. Underlying exceptions never cross the Agent/Host/UI protocol boundary.
10. The Protocol Host creates or receives a single trusted `WorkspaceHookPolicyProvider` and injects the same instance into both the session Runtime and session-less Settings pretrust. Pretrust reads policy before discovery and before any Trust store IO/mutation: only `user_decides` may write; `deny` and `allow_trusted_only` return `workspace_hooks_blocked_by_policy` and `workspace_hooks_policy_requires_pretrust` respectively. A local admin CLI that keeps a pre-review capability must use an explicit entry distinct from the Settings RPC and must not reuse ordinary UI authority.
