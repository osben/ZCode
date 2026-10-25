# Treemapping

Treemapping is the current-turn tool call file activity map in the right Side Pane. It derives data from the
current task's assistant message `toolCalls` and does not consume Git Pane, Git status or Git diff.

## Data and Scope

- The Side Pane `+` menu opens the current turn's live map.
- The Treemapping button right of the assistant message like/dislike opens that turn's snapshot.
- v1 looks at a single turn only, with no cross-turn accumulation.
- For `bash/shell/exec`, v1 consumes only structured `changes` / path / diff metadata and does not guess paths
  from plain stdout or complex command strings.

## Visual Rules

- A directory is a neutral nested box expressing only hierarchy, aggregate diff and directory views; its area
  references the subtree's aggregate `diffCount`.
- A file is a leaf box: green added, yellow modified, red deleted, blue view-only.
- File size mainly comes from `diffCount = added + removed`. A change with no diff uses a minimum change
  weight; view-only uses a smaller weight.
- A deleted file keeps a red historical leaf even if the real file no longer exists.

## Activity Merging

The same file shows one box per turn and the event stream stays in the detail area. State priority:

1. deleted, 2. created, 3. modified, 4. viewed. Created then modified still shows green and accumulates diff;
   viewed then modified shows in the change color and keeps views.
