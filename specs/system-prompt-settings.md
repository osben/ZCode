# System Prompt Settings (Settings → System Prompts)

Status: specification for the Phase 2 editor rework. The mechanism (defaults, override files,
runtime loader, whitelist, storage location) is owned by `docs/system-prompt-overrides.md`; this
spec owns the Settings UI behavior and the service contract additions made for it. Where the two
documents touch, this file wins for UI and service-contract behavior, and `docs/system-prompt-overrides.md`
links here instead of restating it.

## Scope

In scope:

- Inline editing under each section row, keyboard save/cancel, dirty indication, and an explanation of
  why Edit and Restore are disabled while a draft is dirty.
- Loading that shows the loading card only on the first load; saves, restores and focus refreshes update
  the list in place and keep the scroll position.
- Per-row information: localized description, character count and approximate token count, Default or
  Customized badge, on-disk path with an Open folder action, and a note that incognito sessions can ignore
  overrides.
- A "vs saved" and "vs built-in default" diff, with an explicit too-large state instead of a silent empty diff.
- Non-blocking validation warnings (unknown placeholders, missing required placeholders, removed
  confirmation paragraph) and an empty-text block.
- Restore with the default text shown in the confirmation, and "Reset all customized" with the affected
  blocks listed.
- Content revisions on disk, optional `expectedRevision` on writes and deletes, a typed conflict result, and
  a "Changed on disk" state with Reload and Overwrite.
- A collapsible, approximate "Assembled prompt" preview of the main-prompt blocks.

Out of scope (future work, not this round):

- Per-block enable or disable.
- Backups or edit history for overrides.
- File watching (external changes are detected on window focus and on save, not by a watcher).
- Import or export of override sets.
- Any `setting.json` key. All state stays in the override files (the existing fork-safe storage).

## Ownership

| Concern                                                                                       | Owner                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Default texts, runtime order, placeholder sets, text normalization, confirmation paragraph    | `packages/shared/src/system-prompt.ts` (single source for service, UI and CLI)  |
| Override files, revisions, conflict detection, trimming and empty rejection                   | `packages/services/src/system-prompt/systemPromptService.ts` on the target host |
| Pinned target, draft, baseline, editor revision, load status, dirty state                     | `packages/ui/src/hooks/useSystemPromptOverrides.ts`                             |
| Pure rules: dirty, save eligibility, validation, diff, assembled preview, too-large detection | `packages/ui/src/settings/systemPromptEditorModel.ts`                           |
| Rendering and keyboard handling only                                                          | `SystemPromptSection.tsx`, `SystemPromptEditor.tsx`                             |

Components never call the service directly; they go through the hook. The hook resolves services through
the existing workspace-services hooks. Platform operations (Open folder) go through `usePlatform()` /
`IPlatformService.openInFileManager`, never `window.zcode`.

## Service contract

Existing channel and interface (`ISystemPromptService`); no new channel is added.

```ts
interface SystemPromptSection {
  key: string;
  defaultContent: string;
  overrideContent: string | null;
  filePath: string;
  isOverridden: boolean;
  /** SHA-256 hex of the override file's raw bytes; null when the file is missing. */
  revision: string | null;   // new; absent on older hosts
}

type SystemPromptWriteResult =
  | { kind: "ok"; revision: string | null }
  | { kind: "conflict"; currentRevision: string | null };

writeOverride(params: { key: string; content: string; expectedRevision?: string | null }): Promise<SystemPromptWriteResult>;
deleteOverride(params: { key: string; expectedRevision?: string | null }): Promise<SystemPromptWriteResult>;
```

Rules:

1. `expectedRevision` omitted means "no check" (legacy callers and older clients). `null` means "expect the
   file to be missing". A string means "expect exactly this revision".
2. Writes and deletes run under `withFileLock` on the override file path. Inside the lock the service
   recomputes the revision from disk bytes. On mismatch it returns `{ kind: "conflict", currentRevision }`
   and writes nothing. This lock only serializes ZCode's own writes; external editors are not blocked.
   The check-then-rename window is a best-effort race, as documented for the Instructions feature.
3. Trim consistency: a write stores `content.trim()`. Reads already trim, so the stored bytes and the
   effective text agree, and the revision returned from a write is the hash of the stored bytes.
4. Empty rule at the service boundary: `writeOverride` with trimmed-empty content throws. The UI blocks the
   same case before calling the service.
5. Unknown key: throws (unchanged). Keys remain a fixed whitelist; no user-derived filename.
6. `deleteOverride` with a missing file is `ok` with `revision: null`.
7. The `ok` result keeps `revision` (the hash of the stored bytes). The UI patches the saved row from it, so a save does not relist (see "Save path"). A host whose write returns no result, or no revision, is relisted instead.

Compatibility:

- The UI treats a result that is `undefined` or lacks `kind` as success (an older host whose write returns void).
- A section without `revision` (older host) disables conflict detection for that section: the UI sends no
  `expectedRevision` and never shows "Changed on disk".
- The remote proxy (`packages/client/src/remoteServiceAccess.ts`) and the remote service collection
  (`createServerRemoteWorkspaceServiceCollection` in `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`) forward the interface unchanged. The web
  stub (`packages/web/src/main.tsx`) stays on the unsupported home-only service. An older remote host keeps
  working as described above.

## Helpers in shared

`packages/shared/src/system-prompt.ts` exports, in addition to the existing constants:

- `SYSTEM_PROMPT_RUNTIME_SUBSTITUTED_KEYS`: `memory-guidance`, `memory-extraction`, `memory-dream`, the keys whose
  `{{name}}` tokens the runtime substitutes (`renderSystemPromptTemplate` call sites). Only these keys have
  placeholders; every other key is sent literally. Drift test:
  `apps/zcode-cli/packages/core/tests/context-system-prompt-order.test.ts` checks this and the order below.

- `SYSTEM_PROMPT_MAIN_PROMPT_ORDER`: the six main-prompt keys in runtime assembly order (`cli-prefix`,
  `identity-intro`, `harness`, `communication`, `memory-guidance`, `context-management`). The CLI builder
  order in `ContextBuilder.build()` is the reference. The UI display order and the assembled preview both
  read this constant.
- `SYSTEM_PROMPT_BACKGROUND_KEYS`: `memory-extraction`, `memory-dream`.
- `normalizeSystemPromptText(text)`: `text.trim()`. Used by the service, the UI dirty check and save checks.
- `extractSystemPromptPlaceholders(text)`: unique `{{name}}` tokens in order of appearance.
- `SYSTEM_PROMPT_PLACEHOLDERS`: per key, the placeholders. Substituted keys derive their set from the shared
  defaults (`extractSystemPromptPlaceholders` on `SYSTEM_PROMPT_DEFAULTS`, with `memory-guidance` taken from
  `composeMemoryGuidanceDefault("default-index")`), so the required set follows the defaults and is not
  hard-coded in the UI. The other keys have an empty set.
- `hashBytes(bytes)` (`@zcode/shared/node`, next to `withFileLock` and `atomicWriteFile`): SHA-256 hex of raw bytes,
  used by the system-prompt service and by the user-instructions service for their revisions.

## Known limit: memory-guidance default

The Settings default and diff for `memory-guidance` use the `default-index` variant, which inserts the
`MEMORY.md` index pointer. The runtime renders the retrieval branch chosen per session
(`ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH`), so for a session on the other branch the shown default differs from
the rendered text. The drift guard covers the section order, not this branch. Which variant Settings should show
is a product decision that is still open, so this is documented, not changed.

## Validation (pure, `systemPromptEditorModel.ts`)

Warnings never block a save. The only blocking rule is empty text (after trimming).

| Code                   | Condition                                                                       | Applies to                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `unknown-placeholder`  | a `{{name}}` in the draft that is not in that key's placeholder set             | all editable keys (for sections without placeholders the token stays literal text at runtime) |
| `missing-placeholder`  | a placeholder in the key's required set (derived) that is absent from the draft | keys with placeholders: `memory-guidance`, `memory-extraction`, `memory-dream`                |
| `confirmation-removed` | the draft does not contain `DEFAULT_CONFIRMATION_PARAGRAPH` (normalized)        | `communication` only                                                                          |

`memory-guidance` requires `{{memoryRoot}}`. Extraction requires `{{messageCount}}` and `{{existingMemories}}`.
Dream requires `{{memoryRoot}}` and `{{transcriptRoot}}`.

## Diff

- "Changes vs saved" compares the draft with the baseline captured when the editor opened (the effective text
  at that time, equal to the saved override or the default).
- "Changes vs built-in default" compares the draft with the resolved default for that row (the text Restore
  would produce; for `identity-intro` with an active Output Style this is the Output Style intro).
- Diffs use the existing LCS helper in `outputStylesEditorModel.ts`. When the table would exceed the cell
  limit, the model returns `too-large` and the UI shows an explicit "too large to diff" message with the
  line counts. It never shows an empty diff for a non-identical draft.
- The diff area is visible whenever the editor is open, so a customized section can be compared with its
  built-in default before any edit. A selected comparison with no differences shows "No differences.". Only
  the selected comparison is computed, from the deferred draft, so typing is not blocked by the LCS table.
- `diffOutputStylePrompt` returns `null` for too-large inputs (full line counts over the cell budget), and
  `diffSystemPromptText` maps `null` to `too-large`. The table is one flat `Int32Array` over the lines after the
  shared leading run. Only the leading run is trimmed: trimming the trailing run can order a tied same/add pair
  differently, so the output would change. A randomized test pins the output to the reference walk.

## Assembled prompt preview

A collapsible panel at the bottom of the list. It concatenates the effective text of the six main-prompt
blocks in `SYSTEM_PROMPT_MAIN_PROMPT_ORDER`, separated by a blank line, and shows an approximate character
(grapheme) and token total from `describeSystemPromptSize`. The text is rendered only while the panel is open,
and the assembled text is recomputed only when the listing or the output style changes. It is labeled approximate: environment, memory index, tools, workspace instructions and other dynamic
parts are added at runtime and are not shown. `identity-intro` uses the same resolved default as its row,
and `{{memoryRoot}}` stays literal. Tokens use the existing estimator in
`packages/ui/src/v4/conversationStreamingThroughput.ts` (`estimateStreamingTokens`), imported, not copied.

## Row information

Each row shows, in this order: title, Default or Customized badge, a localized description (what the block
does, where it sits in the prompt, when it is active), a size line (characters and approximate tokens of the
effective text), the on-disk path with an Open folder action, then the Edit and Restore actions.

Open folder is offered only for local workspaces. A remote section's path is on the remote machine, so the
action is hidden there and the path is still shown. The action asks the service for the overrides directory
(`getOverridesDirectory`, a pure lookup) and opens it through `IPlatformService.openInFileManager`. The folder
is created by the first save, so when it does not exist yet the action opens its parent, the ZCode data folder.

Rows are memoized. A row re-renders only when its own inputs change (its section, its index, the editor
key or saving state, the dirty flag, the host kind, and its callbacks). The row being edited re-renders on each
draft change, because the editor is part of it. The other rows do not re-render on draft keystrokes.

Active-condition notes that must be in the descriptions:

- `memory-guidance`: included only when persistent memory is enabled for the session.
- `communication`: omitted when the incognito profile turns off the harness.
- `identity-intro`: baseline changes with the active Output Style. An override still wins.
- `memory-extraction`, `memory-dream`: local host only; background agents never run for remote workspaces.
- Incognito note on the section: sessions can ignore these overrides when the incognito profile's
  "System prompt overrides" capability is off.

## Editor behavior

- The editor opens inline under its row. The row's effective-text preview is hidden while the editor is open.
- On open the textarea is focused and scrolled into view (`block: "nearest"`).
- The textarea is monospace and vertically resizable, with a minimum and maximum height so it stays usable on
  phone widths and large displays.
- A dirty row shows a dot. A dirty draft is "dirty" under normalized comparison, so adding only trailing
  whitespace does not enable Save.
- Cmd/Ctrl+S saves when Save is enabled. Esc cancels, using the same discard guard as the Cancel button.
- Edit and Restore on other rows, and Reset all, are disabled while a draft is dirty. A visible note above the
  list says why and names the section holding the draft. Disabled Save shows its reason (empty, no changes,
  or disk changed).
- Save writes with `expectedRevision` = the revision captured when the editor opened (or last rebased).
- The empty-draft state has one visible reason: the save-reason line under the editor. There is no second alert.
- The character count under the editor counts graphemes, the same as the row size line.
- While a save conflict is active, plain Save is blocked; only Overwrite (below) writes.

## Restore and reset

- Restore shows an inline confirmation panel inside the row. It shows the built-in default text that will be
  restored and says the override file will be deleted. Declining performs no write.
- Reset all customized lists the affected blocks (localized titles) in an inline panel above the list. On
  confirm it deletes each overridden file with its loaded `expectedRevision`. The deletes run concurrently,
  one file per key, each under its own file lock. If one entry conflicts or fails, the remaining entries are
  still attempted, and the list refreshes and reports how many conflicted or failed. A single Restore uses the
  same delete path with one entry.
- Restore on a conflicting file refreshes the list and shows a toast; the user repeats the restore if still
  wanted (it is not offered as Overwrite, because the user confirmed a different default-restore than what
  is now on disk).
- On success the editor closes only if it is still the editor that was open when Restore started. The delete
  is async and the editor is not busy, so the user may reopen the section or edit a draft meanwhile; a newer
  editor state is left alone. Reset all applies the same rule to each row it restored.

## Changed on disk

When the editor is open and either the section's current revision differs from the editor's captured revision
(a refresh after window focus), or a save conflict is active, the editor shows a warning state:

- "Reload from disk" discards the draft and rebases the editor onto the listing's text and revision. The draft is
  discarded anyway, so this is safe. After a failed refresh the listing can be behind the conflict: the rebase then
  uses that older revision, and the next Save conflicts again, which is the normal conflict check, not data loss.
- "Show disk version" captures the disk version from the latest listing (its revision and override text) and
  shows that text read-only, with a note that Overwrite replaces it. The draft is not touched. The captured
  version counts as viewed only while its revision is the disk revision the card describes (below). When the
  listing does not yet carry that revision (a conflict whose follow-up refresh failed), Show refreshes the list
  instead of capturing text that belongs to an older revision.
- "Overwrite" is disabled until a disk version has been shown. It keeps the draft and saves it against the
  revision of the shown disk version (see "Conflict revisions"), so the content replaced is the content the
  user looked at. If the file changed again since, the write is refused, nothing is replaced, the list refreshes,
  the shown version is dropped, and a toast reports the change; the user must show the newer version before
  Overwrite is enabled again. A host that reports no revision has no conflict check, so Overwrite stays enabled
  there without a view.

A save conflict stores the `currentRevision` returned by the host on the editor state (`conflictRevision`;
`null` means the file was missing on disk). The state therefore does not depend on the follow-up list refresh
succeeding: if that refresh fails, the warning and the blocked Save remain, and the list keeps its last
revision. The card's disk revision is the conflict's `conflictRevision` when one is set, otherwise the listing's
revision. A listing that reports a different revision than the conflict's supersedes the conflict (it then
describes the disk, and the listing-based state applies); a listing that reports the same revision keeps it.
A failed listing never clears it. Reload clears the conflict and rebases onto the listing, so its revision is
the listing's, not the conflict's.

Overwrite never takes a revision from the conflict or the listing at click time. The conflict revision only
gates plain Save and names the disk revision the card shows, so the revision Overwrite sends is always one the
user was shown. The hook's `saveEditor` returns the conflict (`{ currentRevision }`) so the card can drop the
version it showed.

Closing the editor by Cancel still follows the discard guard. The list refreshes silently on window focus when
the target is ready. Older hosts without revisions never show this state.

## Loading

- The loading card appears only before the first successful list for a host. Later refreshes keep the list
  mounted, so scroll position and open editors are kept.
- Save, restore, reset and focus refresh update sections in place. A failed refresh keeps the last list and logs
  a warning. A failed first load shows the failed card with Retry.
- A focus refresh runs at most once every two seconds, and not while a listing is already in flight.
- A listing that matches the current sections (same revisions, override text, defaults, paths) keeps the
  previous array, so unchanged refreshes do not re-render the list.

## Conflict revisions (decision)

Every conditional call checks against the revision the user reviewed, never against a revision read at the
moment of the click:

| Action           | Checked against                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Save             | The editor's base revision: captured when the editor opened, or when it was last rebased by Reload. |
| Restore          | The revision captured when the Restore confirmation panel opened.                                   |
| Overwrite        | The revision of the disk version the user chose to show (Show disk version).                        |
| Reset all        | The revision each entry had in the listing the user confirmed.                                      |
| Reload from disk | Not a write. It discards the draft and adopts the disk text current at click time.                  |

A newer external edit that lands after review therefore produces a conflict, not a silent replacement. The
captured revisions live in the row or the card that shows them (`RestoreConfirmPanel`, `DiskChangedAlert`); the
hook does not keep a second copy. The card's captured disk version is the only source of the Overwrite revision;
the conflict revision is never sent by itself.

## Save path

- Save sends `{ key, content, expectedRevision }`. An `undefined` `expectedRevision` is dropped by the RPC
  serializer (JSON), so an older or remote host receives no check, the same as a direct call.
- On `ok`, the saved section is patched from the write result (`overrideContent`, `isOverridden`, `revision`)
  and no listing is made. On `conflict`, nothing is written: the list refreshes, the editor shows the
  Changed-on-disk card, and Overwrite (if pressed) reports the change with a toast.
- Dirty and the save block reason are computed once per render. `canSave` is `resolveSystemPromptSaveBlockReason`
  returning `null`; Overwrite uses the same rule with the disk-changed check left out.

## Host routing (unchanged)

The editor targets the pinned host (local or remote). Host switch with a dirty draft asks to discard; declining
keeps the pinned host and the draft. Disconnected remote hosts cannot write. `memory-extraction` and
`memory-dream` are omitted for remote hosts.

## Acceptance scenarios

Unit and component tests cover the rules above. The desktop E2E scenarios are written in
`packages/desktop/test/e2e/settings/manual-review/pending/system-prompt-settings.test.ts`:

- SP-01 (existing): edit `cli-prefix`, save, restore, file created then deleted.
- SP-02: the editor opens inline under the row and is focused; with a dirty draft, the dirty dot and note show,
  Edit on another row is disabled, Cmd/Ctrl+S saves, and Esc on a dirty draft asks before discarding (dismissing
  keeps the draft).
- SP-03: an external write to the open section's override file while the editor is open produces the
  "Changed on disk" state; after Show disk version, Overwrite writes the draft to disk.
- SP-04: the same external write followed by Reload from disk discards the draft and adopts the disk text.

Unit coverage added with the cleanup: the hook tests cover the patch-from-write save (no relist), the relist for hosts
that return no revision, Overwrite against the reviewed revision while a newer disk revision exists, the focus
throttle, and a rejected reset entry. They also cover the conflict revision kept when the follow-up refresh fails,
its release by a listing that reports another revision, and restore or reset closing only the editor that was open
when they started. The card tests cover Show refreshing instead of showing a stale listing, and Overwrite sending the
shown revision. The model tests cover the too-large mapping and the prefix-trim diff against the reference walk
(randomized).

These E2E scenarios are not run in this round (the desktop E2E harness needs a built app); this is stated in
the report.

## Ownership and event order

```text
Settings page (pinned target)
  → useSystemPromptOverrides(pinned)
      load:    listSections  →  sections (revision per key)   [first load: loading card]
      focus:   listSections  →  sections in place              [no loading card]
      save:    writeOverride{expectedRevision}
                 ok        → toast, close editor, patch the saved section in place (relist only when no revision is returned)
                 conflict  → editor.conflictRevision = currentRevision (Save blocked, Changed on disk);
                             listSections in place (failure keeps the conflict state; a listing with another
                             revision clears it)
                 Overwrite → writeOverride{expectedRevision = reviewed revision of the shown disk version}
      restore: deleteOverride{expectedRevision}
                 ok        → toast, close editor only if it is still the one open at start, listSections in place
                 conflict  → toast, listSections in place
  → SystemPromptEditor (inline): model.validate / diff / dirty (pure)
Host (service): withFileLock(path) → read bytes → sha256 → compare → atomic write (trimmed) or delete
CLI new session: bootstrap reads override files at startup (unchanged; running sessions are not updated)
```
