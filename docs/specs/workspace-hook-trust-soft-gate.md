# Workspace Hook Trust Soft Gate Design

> Status: implemented. The 2026-08-13 persistent-trust simplification is defined by [`workspace-hook-trust-persistent-only.md`](./workspace-hook-trust-persistent-only.md); the older descriptions here of `allow_once`, `keep_blocked`, the standalone review panel and SessionStart catch-up are superseded by it.

## 1. First Principles

1. **Untrusted code never runs.** Default-deny is the floor; no interaction design may relax it.
2. **A conversation must not be hijacked by a security decision.** A blocked user clicks "trust all" just to unblock the chat; coerced consent is not consent (consent-fatigue anti-pattern). Trust decisions must be made out-of-band without pressure.
3. **If policy changed behavior, it must be visible.** When a hook is skipped, the user must see in the chat why it did not take effect and where to handle it.
4. **Trust is asynchronous and applies to the future; it never retroactively unlocks the past.** No "turn stops and waits for the review result".
5. **Keep enforcement-point complexity in the admission layer.** Do not spread the security state machine into protocol RPC, queues, UI navigation or other remote layers.

Consequences: the turn never waits for review (2+4); pending hooks are skipped (blocked) this turn (1); a persistent in-session prompt plus one-click review (3); the entire parked-turn protocol machinery is deleted (5).

## 2. Behavior Comparison

```
Old (hard gate):
  user prompt ──ACK──> turn parks in activate() ──forced open of Settings/Hooks──> user forced to decide
                        │                                                              │
                        └──── 10min watchdog / turnStartTimeout (timeout writes no Trust) ────┘
                        (the turn continues only after review; the user is dropped in settings)

New (soft gate):
  user prompt ──ACK──> turn runs immediately, pending hooks are always skipped (HookRunBlocked)
                        │
                        └─> event: WorkspaceHookAdmissionUpdated { pendingCount>0 }
                              └─> snapshot.workspaceHookAdmission
                                    └─> persistent bottom bar [N hooks pending review] [Review] [Dismiss]
                                          └─(user clicks)─> requestWorkspaceHookReview
                                                └─> controller opens a review flow (under supervisor)
                                                      └─> Settings/Hooks untrusted rows show [Trust]
                                                            └─> exact persistent trust persisted, revision bump
                                                                  └─> affects only future natural Hook events
```

Trust-effective chain timing:

```
Renderer                     V4 Server(bootstrap)                Core Runtime
   │                              │                                   │
   │ prompt #1                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ activate(): pending → skip
   │                              │        WorkspaceHookAdmission     │ records skippedSessionStart
   │<── snapshot{pendingCount:2} ─┤<──────── Updated(2) ──────────────┤ + securityRevision R1
   │ [banner appears]             │                                   │ turn runs normally (no hooks)
   │                              │                                   │
   │ click [Review]               │                                   │
   ├─ requestWorkspaceHookReview >│ openReviewFlow + supervise        │
   │<── ReviewRequested ──────────┤                                   │
   │ click [Trust] on a row       │                                   │
   ├─ respondWorkspaceHookReview >│ exact grant → persist → revision R2│
   │<── ReviewSettled ────────────┤                                   │
   │<── snapshot{pendingCount:0} ─┤<──── AdmissionUpdated(0) ─────────┤
   │ [banner disappears]          │                                   │
   │ prompt #2                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ old SessionStart is not re-run
   │                              │                                   │ only later natural events use new Trust
```

## 3. Design Decisions

### D1. Admission layer: pending means skip; no flow, no waiting (core)

`workspace-hook-runtime-admission.ts`:

- Delete `reviewPendingSnapshot()` and its call in `activate()`, the `reviewActivation` state, and the waiting use of the `review` port.
- Pending declarations have runtime semantics **identical** to the existing headless path: the runner emits `HookRunBlocked` per item (`errorCode: workspace_hooks_pending_trust`) and the turn runs as usual. Desktop and headless semantics merge.
- After computing the pending snapshot, `activate()` reports `{ pendingCount, bundleDigest, workspaceIdentity }` through a new port (D2).
- `waitForWorkspaceHookAdmission` stays (trust-store bootstrap still needs it); only the review-wait call sites are removed.
- Fail-closed paths (`bootstrapFailed` / `invalidatedReason`) are unchanged.

### D2. Session-level state carrier: snapshot field (shared + bootstrap)

- `conversationSnapshotSchema` gets an additive field (**must carry `default: null`**, per the snapshot.ts freeze rule):

  ```ts
  workspaceHookAdmission: {
    pendingCount: number;      // count of declarations with configuredEnabled && admissionClass === "pending"
    bundleDigest: string;      // idempotency key for banner dismiss
    workspaceIdentity?: string;
  } | null
  ```

- New session event `WorkspaceHookAdmissionUpdated` (same family as `WorkspaceHookReviewRequested/Settled/Superseded`); the projection writes/clears the snapshot field from it (`pendingCount === 0` → null).
- Trigger points: (1) `activate()` (startup / resume) after evaluation; (2) after exact persistent trust, the controller re-evaluates and publishes; (3) likewise after a toggle rebuilds the bundle or after revoke.
- Do **not** carry admission in `pendingInteractions` (that has blocking, load-bearing semantics: hides the composer, suppresses the spinner, notifications, sidebar). `hooksService.loadHooks` is used only for the Settings static persistent Trust view. The snapshot rides the V4 protocol, so desktop and Web remote share the same source, satisfying the multi-client constraint.

### D3. On-demand review flow: new command `requestWorkspaceHookReview` (shared + bootstrap)

- The command shape clones the non-flow target variant of `revokeWorkspaceHookTrust` (`sessionId + workspaceIdentity + bundleDigest`, no interactionId).
- Handler → the controller's existing `openReviewFlowForNewPendingItems(getCurrentSnapshot())`; an existing active flow is reused (`openOrReuseFlow` is idempotent).
- It **must go through `superviseFlow`**, otherwise the "panel permanently dead after revoke" UAT bug returns (see the header note of `workspace-hook-review-supervisor.ts`).
- The flow deadline only expires the immutable request and sends `ReviewSettled(timed_out)`; it creates no Trust, writes no negative decision and does not clear admission pending. The user can request a new generation from the banner.

### D4. UI: persistent banner + inline Hooks trust (packages/ui)

- New component `WorkspaceHookPendingBanner` in `SessionPane`'s `conversationBottomDock` (sibling of `ConversationQuotaBanner`, above the composer), styled like `PendingCommandRecoveryBanner` (`role="status"`, border/bg-surface, primary action + dismiss).
- Shown when `snapshot.workspaceHookAdmission?.pendingCount > 0` and not dismissed.
- Copy (zh/en, i18n keys `chat.workspaceHookPending.*`, missing-key check like the parity assertion in `workspaceHookTrustState.test.ts`):
  - Body: "N 个工作区 Hook 待审核,本会话暂未启用" / "N workspace hooks pending review; disabled for this session"
  - Primary: "去审核" / "Review"; secondary: "忽略" / "Dismiss"
- [Review] = `setPendingSettingsSectionIntent("hooks")` + `openSettingsTab()` + sending `requestWorkspaceHookReview` via `findWorkspaceHookCommandBinding` (the channel exists to keep a command path when no pending review exists; it currently has no caller).
- [Dismiss] = renderer-local dismiss keyed by `sessionId + bundleDigest`; the banner reappears when the bundle changes (hook content change). Not persisted.
- Remove the forced navigation in `V4InteractionDialogs.tsx` (`presentedWorkspaceHookReviewInteractions` Set + `setPendingSettingsSectionIntent/openSettingsTab`); keep store connect/upsert/clear (the panel data path) and the "never degrade to a generic dialog" guard.
- `chatLoadingVisibility.ts`: `workspaceHookReview` is no longer a chat-loading blocker (the corresponding test assertion is inverted).
- `SessionPane`'s `blockingInteractionId` derivation must exclude `workspaceHookReview`, otherwise opening the review panel hides the composer and banner with `display:none`.
- Remove `WorkspaceHookReviewPanel` and the three inline configured/trust/effective badges on Hook rows.
- An untrusted workspace Hook shows one outline "信任" (Trust) button left of the rightmost config toggle; on success the persistent Trust snapshot refreshes and the button disappears. Trusted rows show no extra state or revoke entry.
- Follow `DESIGN.md` (color/radius/theme/i18n) and the multi-client constraints (the banner source is the V4 snapshot, so web-remote works too).

### D5. SessionStart is not re-run (core)

- When the first real SessionStart arrives, an untrusted declaration is skipped and that event is over.
- Later prompts must not disguise the finished SessionStart as a catch-up and run it.
- Trust created in the current task affects only later natural events; SessionStart takes effect at the earliest in the next new task/session.
- Remove the skipped digest, revision-at-skip and catch-up filter state so a trust action never triggers historical code execution.

### D6. Protocol-layer deletion list (bootstrap)

With the parked turn gone, these mechanisms retire entirely (a hot spot for recent deadlock/timeout-supervision bugs):

| Location            | Removed                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt-turn.ts`    | The whole review observer (`workspaceHookReviewProgress`, deferred/waiters, `observeWorkspaceHookReview`, etc.), the early-ACK branch (`requestAuthority: "workspace_hook_review"`), `monitorTurnStartedAfterWorkspaceHookReview`, the `admittableHookTimeoutMs` delay, `WORKSPACE_HOOK_REVIEW_SETTLE_GRACE_MS`, related types and the dual-authority header clause |
| `prompt-turn.ts`    | `observeAcknowledgedPromptInputFailure` (review-only; all 3 call sites cleaned up)                                                                                                                                                                                                                                    |
| `handlers/queue.ts` | The `finalizeReviewedQueuePromotion` review branch (deleted once no other caller was confirmed)                                                                                                                                                                                                                       |

Kept: the review flow/controller/supervisor (generating immutable operation snapshots on demand) and the `WorkspaceHookReviewRequested/Settled/Superseded` events and projection. The standalone panel and once/user-block branches are removed; a flow timeout only expires the snapshot.

### D7. Compatibility

- The snapshot field is additive with a default, so old clients parse unaffected.
- `requestWorkspaceHookReview` is sent only by the new UI; the desktop server and UI ship in the same bundle, so no new capability negotiation; the `workspaceHookReview` capability is unchanged.
- Headless CLI behavior is unchanged (already skip + diagnostics); desktop merges into the same semantics.
- web-remote: the banner source is the V4 snapshot, which the replayable path carries naturally; stream/queue/blocking-request semantics are untouched.

## 4. Test Plan (tests first)

- **core**: admission skip semantics (pending → no waiting, port reports pendingCount); SessionStart does not re-run even after Trust changes (regression).
- **shared**: snapshot field default parsing; the `requestWorkspaceHookReview` schema.
- **bootstrap**: command handler (idempotent flow reuse, always supervised); `WorkspaceHookAdmissionUpdated` recomputed after settle/toggle/revoke; projection writes/clears the snapshot field; prompt-turn no longer parks (rewrite the five cases from `v4-native-commands.test.ts:968` and three in `v4-native-queue.test.ts` to "direct TurnStarted + AdmissionUpdated").
- **ui**: banner show/hide, dismiss idempotency key, review action; a Hook row shows "信任" only when untrusted with a matching generation and the button disappears after refresh on success; the old panel/status badges do not render; i18n zh/en parity.
- Manual: `docs/testing/workspace-hook-trust-manual-acceptance.md` §1 is rewritten as soft-gate acceptance.

## 5. Explicitly Out of Scope (this phase)

- Pushing pendingCount at session creation (before the first prompt): the first evaluation still happens in `activate()`, so the banner appears after the first message at the earliest, the same interception point as the old behavior.
- Bulk selection, select-all and an in-settings revoke entry.
- Differentiated confirmation between locally edited hooks and repo-provided hooks.
