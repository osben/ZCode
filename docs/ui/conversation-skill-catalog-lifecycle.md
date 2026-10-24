# Composer Skill Catalog Lifecycle

> Status: implemented 2026-08-20 and passing unit/protocol regressions.
> Related capabilities: `capability.session-skill-catalog`, `surface.composer-slash-capability-picker`.
> Related docs: [mention-panel-layout.md](./mention-panel-layout.md), [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) S08.

## Feature Summary

| Field                 | Value                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Change                | The Composer's Skill candidates change from a long-lived workspace-level snapshot to a workspace/session dual-authority catalog |
| User-visible surfaces | The Skills group of `/`; compatibility entries `$`, `¥`, `￥`                                                                   |
| Change layer          | option-source / persistence / recovery                                                                                          |
| Existing code owners  | `useSkills`, `SlashCommandPlugin`, `skillsMentionProvider`, CLI `AgentRuntime`                                                  |
| Out of scope          | The Settings Skill management catalog; Skill install/delete/enable storage; Subagent/command catalog; canonical mention format  |

## Product semantics

The Skill management surface and the conversation candidate surface are two different authorities:

```text
Settings / install / delete / enable-disable
  `-> workspace management catalog (every explicit refresh rescans the disk)

Composer new draft
  |-> prewarm not ready: skills/referenceCatalog(sessionId omitted)
  |    `-> current workspace catalog
  `-> prewarm P1 ready: skills/referenceCatalog(sessionId=P1)
       `-> the catalog frozen when P1's AgentRuntime initialized
            `-> first send promotes to a formal Session S1 (same runtime)

Composer existing hot Session S1
  `-> skills/referenceCatalog(sessionId=S1)
       `-> S1 runtime frozen catalog (newly added Skills are not hot-loaded)

S1 cold resume / Agent runtime restart
  `-> the new runtime rescans the disk
       `-> after the UI runtime revision changes, S1's catalog is requested again
```

So "an existing conversation does not update" is limited to the lifetime of the same resident runtime. A CLI cold resume rebuilds the runtime and re-runs context/Skill discovery, and the UI must re-query with the new runtime authority and must not reuse an old Promise or renderer cache forever.

Whether explicitly typing a Skill name that is not in the frozen catalog can be loaded dynamically by the Agent keeps following the existing rules of the CLI `Skill` tool; the Picker shows only candidates declared by the current authority and does not widen or narrow tool execution permission through this.

## UI surface matrix

| User scenario                  | UI entry             | Option source                                                                 | Display owner             | Authority                                                                     | Mode boundary                                                                        | Must remain isolated from                                                          |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| New draft picks a Skill        | `/`, `$`/Yen aliases | no `sessionId` while prewarm is not ready; with `prewarmSessionId` once ready | request-scoped React hook | the current workspace catalog or the current draft's prewarm runtime snapshot | local/SSH/WSL/Docker all go to the target workspace Agent; mobile reuses shared-host | Must not reuse the previous task's Session catalog; must not change Settings state |
| Existing Session picks a Skill | same                 | same protocol with `sessionId`                                                | request-scoped React hook | Session runtime frozen catalog                                                | desktop continuous/mobile replayable affect only delivery, not catalog semantics     | Must not hot-load because of new files on disk or a Settings refresh               |
| runtime restart/cold resume    | same                 | resend the same session query after runtime restart                           | hook runtime revision     | new runtime catalog                                                           | a remote attachment change is also part of request identity                          | Must not show late results of the old runtime                                      |
| Skill management               | Settings             | `skillsService.list()`                                                        | Settings local state      | workspace disk                                                                | uses the existing target workspace service                                           | Not changed to a session catalog, not bound by the conversation cache              |

## Shared and divergent behavior

| Concern   | Shared                                                             | Deliberately different                                                                     |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Picker    | `/` and `$`/Yen aliases share one Skill catalog and mapping        | `/` still groups with commands/Subagents; `$` shows only Skills                            |
| Canonical | Still writes the existing Skill Markdown/canonical text            | A catalog authority change does not change send, edit, queue, retry, fork                  |
| Discovery | Both workspace and session come from the CLI Skill discovery rules | workspace takes the current disk on every query; session reads the runtime's frozen result |
| Recovery  | local/remote both drop late results by request identity            | desktop continuous and mobile replayable do not share the renderer cache                   |

## State owners and commit sinks

| State/fact               | Draft/display owner  | Authoritative owner                                | Query/commit                                                           | Persistence/cache                                                          |
| ------------------------ | -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| workspace Skill catalog  | Picker hook          | workspace Agent filesystem/config/plugin discovery | `skills/referenceCatalog` without sessionId while prewarm is not ready | request state only, no persistent cache                                    |
| Session Skill catalog    | Picker hook          | `AgentRuntime.skillLoadOutcome`                    | formal `sessionId` or draft `prewarmSessionId`                         | frozen in the resident runtime; rebuilt on cold resume / new draft prewarm |
| Skill management catalog | Settings local state | `ISkillsService` + files/config                    | `skillsService.list/setEnabled/...`                                    | existing files and config                                                  |
| Skill mention            | Lexical draft        | conversation user input                            | existing send command                                                  | session transcript canonical text                                          |

## Must-preserve invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath` handles only workspace identity isolation; `workspacePath` is still used for Skill file discovery.
- Request identity includes at least workspaceKey, remoteSessionId, formal sessionId/prewarmSessionId/draft, runtime revision and request sequence; on a scope change the first frame is cleared and old results fail closed.
- A Session query that cannot find the session reports a protocol error; silently falling back to the workspace authority is forbidden.
- Settings refresh, install, delete and enable-disable only invalidate the runtime of an unpromoted draft and do not hot-update an existing resident Session.
- `/` and `$`/Yen aliases do not keep two catalogs; the selection result keeps the existing canonical Skill mention.
- Relay and desktop main do not own the Skill catalog and only pass the query to the target workspace Agent; this change does not alter the conversation stream semantics of `desktop-continuous` / `web-remote-replayable`.

## Feature relationships

| Rank           | From                  | Edge           | To                                 | Why inspect it                                                            | Evidence                                      |
| -------------- | --------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| must-inspect   | session Skill catalog | renders-in     | `/` and `$` Skill Picker           | The two entries must share one authority                                  | `SlashCommandPlugin`, `skillsMentionProvider` |
| must-inspect   | session Skill catalog | served-by      | `skills/referenceCatalog`          | Prevent UI/CLI double scanning from forking the catalog                   | protocol schema/handler/service tests         |
| must-inspect   | session Skill catalog | state-owned-by | `AgentRuntime.skillLoadOutcome`    | The source of fact for a frozen hot Session                               | core runtime test                             |
| conditional    | session Skill catalog | recovers-via   | runtime restart/cold resume        | The new runtime must be re-queried and old results must not be backfilled | hook runtime restart test                     |
| invariant-only | session Skill catalog | constrained-by | workspace/remote delivery boundary | Local and remote must hit the target Agent                                | workspaceIdentity/remoteSessionId assertions  |

## Codegraph evidence

| Seed                        | Query                                                | Direct callers/key path                                                         | Depth | Interpretation                                                     |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| `useSkills`                 | codegraph explore unavailable; focused `rg` fallback | `SlashCommandPlugin`, `useSkillsMentionProvider`                                | 2     | The two Picker entries currently share a workspace-level store     |
| `skillLoadOutcome`          | focused `rg` fallback                                | written by `ensureContextInitialized`, read by the context builder / Skill tool | 2     | A resident runtime already has a naturally frozen catalog          |
| `usePluginReferenceCatalog` | focused `rg` fallback                                | Plugin mention provider -> Agent protocol                                       | 2     | A verified reference implementation of workspace/session authority |

## Graph drift and delta

The existing feature graph declares only the slash Skill surface and has no state owner or protocol service for the Session Skill catalog. This implementation adds `capability.session-skill-catalog`, `state.session-skill-catalog`, `service.skill-reference-catalog` and their semantic edges to the Composer, the conversation runtime and the workspace/delivery boundary.

## Boundary decisions and accepted cases

| Boundary           | Decision                                                                                       | Includes                                                                      | Excludes/prunes                                           | Source                                |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| Hot update         | A resident Session does not update                                                             | After a manual file add or Settings change, the old Session keeps its catalog | No file watcher                                           | user confirmation + CLI context guard |
| New task           | A new draft creates a new prewarm runtime and reads the current workspace catalog before ready | A manually added `SKILL.md`                                                   | The previous task's Session/runtime catalog is not reused | user confirmation                     |
| cold resume        | Rescan with the new runtime                                                                    | Recovery after app/Agent restart or resident eviction                         | The old catalog is not persisted forever                  | current CLI resume implementation     |
| Management surface | Keep the live workspace catalog                                                                | All Settings management actions                                               | No session key is added                                   | user confirmation                     |

| Case ID | Setup                                                           | Action                                               | Assertions                                                                                                    | Evidence              | Status   |
| ------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| S08-A   | Manually add a Skill before the new draft/prewarm is created    | Open `/` and `$`                                     | Both entries show the new Skill; authority=workspace before prewarm ready and that prewarm Session afterwards | UI + protocol         | accepted |
| S08-B   | Add a Skill after S1 has initialized                            | Open `/` in S1, then create a new draft and open `/` | S1 does not show it; the new draft does                                                                       | UI + runtime/protocol | accepted |
| S08-C   | The disk catalog changes before and after an S1 runtime restart | Reopen the Picker after restart                      | Drop old results and show the new runtime catalog                                                             | UI + runtime event    | accepted |
| S08-D   | Remote attachment/session switch with a late old request        | Switch scope                                         | First frame cleared; accept only the new workspace/session/runtime result                                     | UI + service params   | accepted |
| S08-E   | The draft goes from no prewarm to P1 ready                      | Keep/reopen the Picker                               | The request key switches to P1; taskId stays null; accept only the P1 runtime catalog                         | Composer + hook       | accepted |

## Verification

- The formal Desktop E2E `conversation-session-v4-mention.test.ts` writes a temporary `.zcode/skills/e2e-session-skill-catalog/SKILL.md` into a real workspace: neither `/` nor `$` of the old resident Session shows that Skill; after clicking new task both entries show the same canonical `skill:` candidate.
- Latest passing artifact: `desktop-e2e-20260820-135214-127`. This VM represents S08-A/B of desktop local; runtime restart, remote attachment, late results on scope change and prewarm key switch continue to be evidenced by focused tests, and unexecuted remote/restart combinations are not passed off as Desktop E2E.

## Unresolved questions

None. Whether the Subagent and command catalogs adopt a similar Session lifecycle is outside this change and is audited separately.
