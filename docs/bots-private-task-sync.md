# Private-chat bound task continuous delivery

## Behavior and boundaries

After a Feishu/Lark, Telegram, or WeChat iLink private chat is bound to a task, AI output from IM, desktop, and mobile input is delivered back to the currently bound user. The channel replyMode applies; desktop input text is not additionally forwarded. Approvals/questions keep the source authorization of the original input — a persistent subscription never widens permissions.

A turn that completes, fails, or is stopped clears only that turn's state and never releases the bound subscription. Switching task, workspace, user, or bot identity, or disabling/deleting, invalidates the old target; network requests already sent cannot be recalled. On enable, start, and connected-workspace recovery, the subscription follows later events — no history replay, no proactive remote connection for recovery.

A background job checks existing remote connections every 10 seconds and restores available subscriptions, without proactively reconnecting; established subscriptions keep using continuous live events.

One workspaceIdentity (local fallback workspacePath) plus task shares one Bot continuous event source; each receiving target processes serially and independently, and one target's failure never blocks others. Automation tasks match their turn by the Host-dispatched runId, still use the terminal-state summary, and merge with normal delivery to the same target without duplication. Input admission and execution state stay with the existing task owner; no new accepted queue; desktop continuous and mobile replayable boundaries are unchanged.

```mermaid
sequenceDiagram
  participant UI as desktop/mobile/IM
  participant Task as task owner
  participant Bots as BotsService
  participant IM as channel
  UI->>Task: existing input command
  Task->>Bots: bot-channel-continuous output event
  Bots->>Bots: validate current binding, reset/finalize per run
  Bots->>IM: send the reply for the matching target
  Note over Bots,IM: a finished turn keeps the subscription; after rebinding, the old target must not keep sending
```

## WeChat and failure handling

After inbound authorization, the latest context_token is saved per bot account and user in CredentialService; sends read the latest value, survive restarts, and assume no fixed validity period. Tokens must never appear in logs or getBotStates. On missing credentials or platform rejection, the existing deliveryError shows the failure plus guidance to re-send via WeChat, and the task output is retained. Updating the token only restores future sends; old replies are never auto-resent.

The current process keeps the most recent failed reply per bot; the user may explicitly re-send the full text, with a UI hint that already-received content may duplicate. It is invalidated on rebinding, and restarts keep no pending re-send body. Unknown outcomes are never auto-resent, to avoid duplicate messages. Send throttling and business errors must be preserved; HTTP success is not equal to platform delivery success.

## Acceptance

- Three channels: after the first IM turn, desktop and mobile each get one reply for two consecutive turns, with no text or card pollution from earlier turns.
- Multiple targets sharing a task create exactly one underlying subscription; each target gets its reply independently; one target failing does not affect another.
- Automation tasks to the same target send only the terminal summary without duplication; normal input afterwards restores the configured replyMode.
- Switching task/workspace, unbinding, disabling, and deleting block late output; re-enabling restores the subscription. The same path with a different workspaceIdentity does not cross-wire.
- Restart recovers valid bindings without replaying history; a disconnected remote is never proactively connected, and subscriptions resume after reconnect.
- WeChat: latest-token replacement, restart read, user/bot isolation, and visible failure on missing or stale tokens; unauthorized input cannot overwrite a token.
- Feishu streaming cards of two turns stay independent; Telegram rejections, throttling, and format fallback failures are never reported as success.
- Permissions and questions triggered by desktop/mobile must not gain new actionable IM authorization entries through the private-chat subscription.

## Evidence

2026-09-17:

- Service/provider/UI: `botsService.privateSync.test.ts` covers continuous multi-turn, multi-target, automation runId isolation, WeChat credential update and restart read, rebinding, explicit failure retry, and mirror batch; other Bot regressions and UI retry interactions ran together: 28 files, 432 cases pass.
- Desktop runner: `BOT-E2E-PS-01` passes for all three channels with controlled streams, proving the service → HTTP chain and synthesized desktop/mobile input sources — it does not impersonate real mobile/CLI input. Automation delivery and Feishu streaming-card specs re-run: 3 specs pass.
- Root typecheck, E2E typecheck, and architecture check pass; lint 0 errors, 48 pre-existing warnings.
- Real-component browser preview: 390px/1280px, Zai light/dark, Chinese/English; success hides the button, failure allows retrying, no horizontal overflow, no console errors.
- Not yet tested with real IM accounts: WeChat long-term inbound silence, Windows/Linux, real mobile, remote reconnects. The new E2E stays pending — not promoted and not in CI.
