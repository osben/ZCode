# Automation workspace selection boundary

## Feature/change summary

A manually created automation (scheduled task) must be bound to a real project. `AutomationEditView` reuses the ordinary conversation draft's workspace menu but must not inherit the entry that switches to a non-project workspace. Only the caller capability boundary is constrained; workspace, session, stream, queue and remote-control protocols are unchanged.

## Clarification log

| Question                                                                 | User confirmation        | Fixed boundary                                                  |
| ------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------- |
| Should the `X` in the screenshot be hidden globally or only for automations? | Only for automations     | Ordinary conversations keep the original hover/focus replacement |
| May the automation dropdown offer "work outside a project"?              | No                       | Automations cannot enter the conversation backing workspace      |
| Do other entry points change?                                            | No, they stay as they are | Ordinary conversations keep showing `X` and the menu item        |

## Domain scope and state owners

| Domain                                | State owner                                                   | Rule                                                                       |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| UI shell / workspace selector         | `ChatEmptyWorkspacePreviewMenu` props + renderer render state | Carries a complete conversation-workspace selection capability guard       |
| Automation form                       | `AutomationEditView`                                          | Explicitly disables that capability                                        |
| Conversation workspace                | `WorkspaceShellLayout` + tab purpose                          | Capability stays enabled by default; target switching logic is unchanged   |
| Host / Agent / protocol / persistence | Existing workspace/session authority                          | Unchanged; the disabled entry is rejected at renderer UI admission, before any of these |

## State and event sequence

```text
ordinary draft                         manual automation form
      |                                         |
      | capability = enabled                    | capability = disabled
      v                                         v
hover/focus project chip                 hover/focus project chip
      |                                         |
      +-> project icon fades                    +-> project icon remains
      +-> detach X appears                      +-> no detach X
      +-> menu has work-outside-project         +-> menu omits work-outside-project
```

## Candidate combinations and pruning

| Candidate | Surface                    | Capability       | Expected result                                                                    | Status                    |
| --------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| AWS01     | Ordinary project draft     | enabled          | `X` and "work outside project" are available; the project icon fades on hover/focus | accepted                  |
| AWS02     | Manual new automation      | disabled         | Neither `X` nor "work outside project" exists; the project icon stays visible       | accepted                  |
| AWS03     | Editing an existing automation | workspace locked | Keeps using the disabled button; never enters the reused menu                    | pruned: existing edit guard |

Theme, locale and operating system do not change whether the entry exists; the shared class/i18n contract covers them, so no Cartesian product is run. The automation selector has its remote entry closed, so it is not combined with SSH/WSL/Docker, `workspaceIdentity` or mobile replayable recovery. Remote identity isolation for ordinary conversations stays covered by CWP07/CWP08.

## Accepted cases and evidence

| Case          | Setup                         | Action                       | Assertions                                                            | Evidence                                                       | E2E status                                         |
| ------------- | ----------------------------- | ---------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| CWP11 / AWS01 | Ordinary project draft        | Hover/focus chip, open menu  | Icon-fade class exists; detach and menu item exist                    | focused render test + DOM contract                             | partial-unit                                       |
| CWP11 / AWS02 | Manual new-automation capability | Hover/focus chip, open menu | Icon-fade class absent; detach and menu item absent                   | focused render test + `AutomationEditView` capability wiring  | partial-unit; desktop GUI representative missing   |

## E2E handoff

The follow-up desktop GUI representative case only needs to open "Automations -> create manually" and inspect the workspace chip and expanded menu. This path sends no prompt, so the provider request policy is declared `none`. No provider fixture, remote workspace or SSE timing is needed.
