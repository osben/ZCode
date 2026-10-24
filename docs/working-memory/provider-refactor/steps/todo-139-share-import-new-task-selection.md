# Todo139: Share import reuses the ordinary new-task model and mode initialization

Status: implemented; local unit tests, browser interaction and review done (2026-09-12). Full share
server / native first-message RPC joint acceptance is not done.

## Goal and root cause

A new task created by share import behaves like an ordinary new task of the receiver: Provider, model,
thinking level and mode/permission. It does not inherit the sharer's execution settings.

Gap: `ConversationShareService.importShare()` called `createSession()` without model/mode selection and
then activated a real Session. The Composer reads new-task preferences only when `sessionId === null`;
for an existing Session it reads the session selection and keeps explicit empty states. So the first share
import skipped new-task initialization.

## Rules

| Item                     | Priority order                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Provider, model, thinking level | initialized new-task draft of the target workspace -> full ModelSelection of the most recent accepted Submission -> public default selection |
| Mode / permission        | initialized new-task draft of the target workspace -> mode of the most recent accepted Submission -> product default build |

- Extract or reuse the ordinary new-task initialization entry so both entries share rules; the share service does not copy a default-model algorithm.
- "Existing draft first" includes its explicit empty selection; a user-cleared or invalid selection is not treated as missing and replaced by a default. Reuse the current public effective-selection resolution and validation; no separate fallback.
- Copy only selection config, not body, editor content, mentions or attachments; the ordinary new-task draft is not deleted or moved.
- Preferences are read for the actual landing workspace `workspaceIdentity?.trim() || workspacePath`; when a remote workspace falls back to local, use the final local workspace, not the remote source preferences.
- Only the first-created imported task is initialized. Repeated import reusing the Session, reopening or restoring history never overwrites the session's saved selection and draft.
- Initialization only prepares this session's Composer draft; the later full Submission remains the execution-config commit boundary. A successful import does not mean a message was submitted and must not refresh Recent.
- With no model, a not-ready Registry or a non-executable selection the shared content still imports and opens; initialization completes after the public read is ready, and sending is gated by the existing rule to pick a valid model. A model request is never a precondition of import.

## Ownership and order

```text
ordinary new task ---------+
                           +-> shared new-task selection initialization
first share import -> actual workspace -> independent Session Composer draft
   -> user sends full Submission -> original accept/execute/persist chain
repeated import / restore existing session -> keep existing Session selection and draft
```

- Renderer owns draft and Recent; Host provides public defaults and the effective-selection View; the import service keeps atomic content/artifact/Session import and does not touch Renderer storage.
- Initialization happens once; Registry replies, import retries and late results never overwrite a user-edited draft nor leak into a later-switched workspace/Session. Reuse existing scope and initialization mechanisms; no timeout patch or second sync state.
- Import and initialization are separable; deferred initialization must not be permanently sealed by an empty-Session snapshot arriving first, and "Session has no model" alone does not identify a first import.
- No change to shared-host, desktop continuous / mobile replayable, CommandInbox, account sync or in-flight model binding; no historical migration or back-fill of old imported sessions.

## Code locations

- `packages/services/src/conversation-share/conversationShareService.ts`: import and Session creation.
- `packages/ui/src/root/useRootPlatformEffects.ts`: workspace/Session activation after import.
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`: ordinary new-task vs existing-Session initialization branches.
- `packages/ui/src/lib/composerRecent.ts`, `packages/ui/src/v4/composer/composerDraftStore.ts`: recent accepted preferences, draft storage and isolation.
- [Share spec](../../../conversation-share-v1.md), [Todo71](todo-71-persistent-composer-draft-and-submission-state.md): first-import boundary synced; existing empty-selection protection is not overturned.

## Acceptance

- [x] Spec updated; shared initialization entry, first-import marker and activation order fixed; tests before implementation.
- [x] Same workspace, ordinary new task vs share import: existing draft, Recent only, public default only give identical model identity, thinking level and mode; an empty-draft intent is not filled with defaults.
- [x] No usable model, delayed Registry, invalid selection, user edits before the reply: content opens, initialization never overrides user intent.
- [x] Actual target workspace, remote fallback to local, same path with different identity; the ordinary draft body and config are kept.
- [x] Repeated import and reopen keep the Session draft/saved selection, do not reset continued tasks, and do not update Recent at import.
- [ ] Interaction: after import opens, toolbar model/level/mode, and the first submission's full modelSelection/mode and share `context_refs` (not just menu text); keeps the existing E2E pending/promotion rule.
- [x] Related unit tests, browser or runnable E2E, typecheck, lint, architecture; ordinary new-task and history-restore regressions reviewed; multi-end limits recorded.

## Result (2026-09-12)

Real Hook and 10 browser groups pass: Root/Recent/default, explicit empty selection, delayed and
user-first re-selection, actual identity, repeated import not overwriting. First-message
modelSelection/mode is verified with the real freeze function; `context_refs` retention is checked by code
review and existing unit tests, and the full share server -> native RPC is not run, so that item stays
open. Evidence, pre-existing failure classification and multi-end limits are in
[the review record](../research/todos-136-139-140-review-20260912.md). Nothing was pushed.
