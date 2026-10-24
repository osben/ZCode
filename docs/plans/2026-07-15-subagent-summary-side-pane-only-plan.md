# Subagent Navigation And Directory Implementation Plan

> Status: implemented. The product contract lives in `docs/subagent-session-side-tabs.md` and
> `docs/agent-tool-call-renderer.md`; this file keeps the pruning decisions and the open backlog.
> Full history: `git show b8876e8b:docs/plans/2026-07-15-subagent-summary-side-pane-only-plan.md`

**Goal:** An Agent/Task tool call in the parent conversation is always a one-line summary; it never
expands the prompt, output, activity or child tools. With a `childSessionId`, clicking the row opens
a read-only right-side tab on desktop and regular Web, and the existing right drawer on mobile
`/remote`. Without a `childSessionId` the row is not clickable. Desktop and regular Web also offer a
directory of the current parent session's subagents, grouped into running and finished, with finished
items paginated. A failure reason stays in both the parent summary status and the current child
detail; no persistence or timeline row is added for child detail.

**Non-goals:** no subagent-spawns-subagent runtime, no persisted child errors, no change to
permission/AskUserQuestion ownership, no change to side-pane tab persistence or subscription
lifecycle, no new database table or Agent tool field, no Workflow change, no directory on mobile,
and no separate Host/Agent runtime for mobile.

## 8. Pruning Decisions And Backlog

| ID  | Pruned or undecided combination                     | Guard / invariant                        | Handling                                                        |
| --- | --------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| P01 | Any inline Agent prompt/output/activity/child tools | `agentSummaryNeverExpandsInConversation` | V4 inline path deleted, no fallback kept                        |
| P02 | Temporary detail tab when there is no child         | `childDetailRequiresChildSessionId`      | Static summary; `toolUseId` never becomes a second identity     |
| P03 | A separate runtime or Host for mobile               | Shared-host attachment invariant         | Reuse the existing MobileShell + Host/CLI                       |
| P04 | Nested provider E2E                                 | Current runtime capability guard         | UI/reducer unit tests only; add E2E when the capability returns |
| P05 | New persistence for child errors                    | User decision                            | Consume only the current `control.lastError`                    |
| P06 | Special jumps for permission/AskUser                | User decision                            | No new UI or timing                                             |
| P07 | Mobile hidden-tab lease optimization                | Not part of the interaction fix          | Keep as is; separate performance case                           |

### Open, not blocking

| Question                                                                  | Current default                                                       | Constraint                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| How does a mobile failed row with no child show the full raw error?       | No dedicated tap/popover; keep the short status until product decides | Never restore inline expansion for this; if added later, only a separate error-status entry, never a child tab |
| Should an inactive child lease be released when the mobile drawer closes? | Keep the current side-pane lifecycle                                  | Decide separately from relay bandwidth, memory and reopen-latency data                                         |
