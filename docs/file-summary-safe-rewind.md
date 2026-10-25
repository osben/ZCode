# Summary file rewind safety precheck

## Background

The file-change button on a message summary rewinds this turn's file changes. The old path called workspace rewind directly and relied only on writing back checkpoint `beforeContent`, with no confirmation that the file was unchanged since the user's click. When one file is modified by several tools in the same turn, rewind must replay checkpoints in reverse creation order, not do a single write-back from the final aggregated diff.

## Goals

- Clicking the summary file-rewind button opens a confirmation dialog first.
- The dialog lists per file which files can and cannot be safely rewound.
- File changes made by bash/shell tools do not take part in summary file rewind and never appear in the rewindable list.
- A file modified by multiple non-bash tools must be rewound by replaying checkpoints in reverse order.
- Re-run the precheck before applying; if any unsafe file exists, write no file this time.
- Desktop and mobile remote control reuse the current session host; no separate runtime.

## Non-goals

- No "re-apply". Checkpoint artifacts reliably store only pre-change content; post-change content cannot be safely restored.
- No partial rewind. P0 is all-or-nothing: any unsafe file disables the confirm button.
- The write-back content is not inferred from UI `fileChanges.snapshots` or tool results; the precheck and write-back are done by the agent runtime.

## Boundary with editUserQuery combined reset

- Summary `applyFileRewind` stays workspace-only; it may show ignored shell files and rewind the remaining safe files.
- Inline-edit `editUserQuery(workspaceMode=rewind)` requires a full rollback of the target turn: unsafe, ignored-shell, unsupported, or missing safe checkpoints all return a structured blocked result, writing no file, trimming no conversation, and sending no model request.
- The combined mode must re-run the precheck, write files, and commit the branch cut inside one Agent command; the UI must not chain two CAS commands.
- Multi-file writes use a compensation journal; if branch/admission fails before the commit point, restore the pre-command file contents and old branch metadata.

## Protocol

Two new ZCode Protocol session methods:

- `session/previewFileRewind`
- `session/applyFileRewind`

Parameters reuse the session history target:

```ts
{
  sessionId: string;
  target: ZCodeSessionHistoryTarget;
  expectedRevision?: number;
}
```

preview returns per-file results:

```ts
{
  sessionId: string;
  target: ZCodeSessionHistoryTarget;
  canApply: boolean;
  safeFiles: Array<{
    path: string;
    action: "restore" | "delete";
    operationCount: number;
    toolNames: string[];
  }>;
  unsafeFiles: Array<{
    path: string;
    reason:
      | "external_modified"
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "unsupported_checkpoint"
      | "file_read_failed";
    operationCount: number;
    toolNames: string[];
  }>;
  ignoredFiles: Array<{
    path: string;
    reason: "bash_ignored";
    operationCount: number;
    toolNames: string[];
  }>;
}
```

`applyFileRewind` returns a fresh post-precheck preview, whether it applied, and the resulting snapshot.

## Runtime algorithm

1. Locate the checkpoint owner from the target. Checkpoints are owned by this turn's user message; when the UI passes an assistant message, the protocol layer normalizes to the parent user message, then falls back to matching a raw assistant step under the same parent. A `turn` target likewise resolves to that turn's user message.
2. Read the owner's workspace/both checkpoints. Multiple checkpoints in one turn are kept in creation order.
3. Read all checkpoint artifacts; files of a checkpoint whose artifact fails to read are marked unsafe.
4. Ignore bash/shell/terminal artifacts.
5. Build the operation sequence from non-bash artifacts and check in reverse checkpoint creation order.
6. A file's current content must equal that checkpoint's after content before it may be written back to its before content. The after content comes preferably from an explicit artifact field; old artifacts can rebuild it from `beforeContent + structuredPatch`.
7. Precheck simulates the write-back and never touches disk. Apply re-runs the same precheck; with `canApply=false`, no file is written.
8. Apply writes back step by step in reverse checkpoint order, so multi-tool files return to their state before the turn.

## UI behavior

- The summary header button only opens the dialog.
- The dialog shows rewindable files; the unsafe block appears only when unsafe files exist. File rows show path, action, and tool/operation counts.
- With unsafe files, the confirm button is disabled and the user is told to handle those files first.
- On successful apply, refresh the session snapshot; the summary's `fileState` becomes `reverted`.

## Remote-control boundary

This is a session command and does not change task realtime transport semantics. Desktop keeps the `desktop-continuous` main link; mobile remote control calls the same session host through the shared-host attachment and restores UI from the replayable snapshot, without spreading replayable runtime-restore logic to desktop.
