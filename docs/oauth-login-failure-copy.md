# OAuth Login Failure Copy and Failure-state Interaction

OAuth login can fail with provider-, network-, token-exchange- or account-state-specific errors.
The login entry shows users only clear, retryable feedback and never surfaces raw underlying errors
on the login page.

## Rules

- The OAuth failure copy shown at the login entry is uniformly: `登录失败，请重试` (login failed,
  please retry).
- Root-layer OAuth callback failures and login-entry-initiated OAuth failures share this one copy.
- The specific error reason goes to the UI logger only — never into the `oauthError` store or the
  visible `error` state of `useOAuth`.

## Failure-state interaction

- The failure state is a three-part set: a warning Alert + "重新登录" (retry, default — retries the
  most recently failed channel) + "取消" (cancel, outline, styled like the waiting-state cancel).
- While failed, the channel button list does not render (condition
  `status === "idle" && !oauthError`). All three failure entries (init failure / polling failure /
  deep-link callback failure) share this one visual, so the failure block and channel buttons never
  appear together with entangled state.
- "取消" matches waiting-state cancel semantics: it ends the failed flow and returns to the channel
  list without closing the login entry. Switching channels goes "取消 → channel list"; retrying the
  same channel goes "重新登录".
- Before a new login starts (`startTrackedLogin`), any residual store `oauthError` is cleared, so a
  failure notice never shares the screen with a new flow's waiting state (e.g. closing the entry
  after failure, then auto-resuming login from settings).
- Retry, switching login method (API key) and other interactions are unchanged.

## Compatibility

- Desktop and web share the `packages/ui` login entry; the copy converges in the UI layer.
- No OAuth protocol, host process, relay or session/task realtime changes; desktop `continuous` and
  mobile remote `replayable` semantics are unaffected.
