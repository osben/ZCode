# UI upstream sync 3.16.1: UI-2a ledger (draft send path)

Scope: re-apply the fork draft send path onto the upstream 3.16.1
`SessionPane.tsx` shape. Design and owners: `specs/ui-draft-send-path.md`.
Base `aac47556`, target `0a1fc56d`, fork `9c2434f7`. Branch
`claude/upstream-sync-ui-2a` on top of PR #215 (`claude/upstream-sync-ui`).

## Ledger rows (bucket 7 S1-S6 status)

- S1 draft send path: DONE. `dispatchSendTextAfterConfig` has a create route
  for `executionWorktree`, `incognito`, `preparedSessionId` / `preparedAttemptId`
  (createSession payload, reupload of attachments for worktree sends,
  `handleDraftSessionCreated` skipped for prepared sessions). Prewarm route is
  unchanged upstream code.
- S2 incognito draft prewarm disabled: DONE. `useDraftSessionPrewarm.enabled`
  adds `!incognitoDraftActive`. `prewarmTargetBeforeSend` is skipped for
  incognito (fork rule).
- S2 worktree preparation callbacks (`prepareWorktreeSession`,
  `syncWorktreePreparation`, `handleWorktreePreparationFailed`, `handleResumeError`)
  and composer props (`voiceDictationEnabled`, `onPrepareWorktreeSession`,
  `onSyncWorktreePreparation`, `onWorktreePreparationFailed`, `onResumeError`):
  already wired in PR #215; verified by typecheck and the composer tests.
- S3 incognito create gating and error toast: the toast path
  (`incognitoUnsupportedMessageId` in `handleSendText`) is already in PR #215.
  The create route forwards `incognito` to `createSession` (fail closed comes
  from the Host/CLI rejection, surfaced by the same toast).
- S3 `/plan` shortcut: NOT restored (decision: upstream plan UI replaces it).
  Fork `planShortcut` branches in SessionPane are not ported. Fork tests:
  `v4SlashCommands` `/plan` cases stay `it.skip` with `TEMPORARY(UI-2)`
  (UI2-PLAN-SHORTCUT). Fork `v4SessionPaneModelSwitchRecovery` describe
  "SessionPane /plan shortcut" and case "carries draft Plan intent through
  session creation" are not restored. Upstream describes "SessionPane Plan
  picker action" and "SessionPane Plan mode goal guard" stay as upstream wrote them.
- S4 `remoteSessionId ?? undefined` casts: not needed. Typecheck clean.
- S5 / S6: wired in PR #215; see the bucket 7 ledger rows.

## Fork tests restored or added (packages/ui/test)

- `v4SessionPaneModelSwitchRecovery.test.ts`, new describe
  "SessionPane draft send route (create route)":
  - restored fork case "activates the prepared worktree ..." adapted to the
    upstream shape: the `/plan` prefix and its `planEnabled` expectation are
    removed; createSession carries `preparedSessionId`, `expectedAttemptId`,
    `executionWorktree`; sendText carries attachments, context and quotes;
    reupload runs once for the prepared session.
  - added: execution-worktree first send with a warm draft present creates the
    session on the send path, reuploads attachments, and never calls
    `beginPromotion` / `promote` on the warm draft.
  - added: incognito first send with `useDraftIncognitoIntentStore` active keeps
    `useDraftSessionPrewarm.enabled` false and creates the session with the
    frozen profile.
- Fork case "不记录无预热 fallback createSession 的首次绑定" (fork file line ~992)
  is NOT restored: it asserts a plain-draft fallback create, which upstream
  forbids (`waitForSession` rule). Upstream case "不记录预热尚无投影时首发的首次绑定"
  stays. The new create route is covered only for marked sends.

## Known gaps (honest)

- Create route does not reproduce upstream's `modelUnavailable` highspeed
  invalidation branch (the `ack.status !== "accepted"` special case in the
  prewarm route). A rejected create-route send throws the reason code, and the
  Composer keeps the draft. Risk: a highspeed card on a worktree or incognito
  first send stays locked until the next turn. Owner decision needed (UI-2b).
- Create route does not wait for an in-flight prewarm session. A worktree draft
  may leave one unpromoted warm draft; the owner deletes it when the pane leaves
  draft state. Not measured in a live Host.
- Incognito attachments: the create route passes ready attachments as-is (fork
  behaviour). The pre-upload binds to the prewarm session, which an incognito
  draft never creates. Unverified in a live Host; covered by the composer bucket
  tests only.
- Sidebar owner for drafts and `/plan` remain UI-2 rows listed in the
  integration ledger (not part of this port).

## Verification (this branch)

- `tsc -b` for rpc, provider, provider-node, acp-agent-runtime, shared,
  services, client, ui: clean (exit 0).
- `pnpm lint`: 0 errors; the 71 warnings do not touch the changed files.
- `oxfmt` applied to the changed files.
- `node scripts/run-vitest.mjs run packages/ui/test/v4SessionPaneModelSwitchRecovery.test.ts`:
  93 passed (includes 3 new cases).
- Baseline on PR #215 head before the change: 11 related send-path files,
  183 tests, all passing.
- Not yet run at the time of this entry: `pnpm typecheck` (full),
  `pnpm architecture:check`, `pnpm fmt:check`, `pnpm test:pre-push`, full
  `pnpm test`. See the PR description for the final results.
