# Changes Tool Call Grouping

## Release state

The feature is implemented and off by default as a user setting. "Group file changes" in Settings persists as the app-level `toolGroupingChangesEnabled`; when missing, `ENABLE_CHANGES_TOOL_CALL_GROUPING=false` is the fallback. When off, the production UI keeps consecutive Write/Edit/ApplyPatch raw tool rows. The Changes renderer, the responsive summary and the focused tests are kept, and no session, protocol or runtime state is added.

## Goal

Consecutive file-writing `ToolCallRow`s are aggregated in the conversation UI into one `Changes` parent group. The parent is only a display node of the shared renderer and adds no protocol, runtime, persistence or replayable state; the original Write/Edit/ApplyPatch rows stay as children with their full diff, errors and snapshot field notices.

## State and order

```text
Write/Edit ── Write/Edit ── Write/Edit ── visible non-file-write row
     └──────── Changes: in_progress ────────┘
                                             └─ Changes: completed
```

- The parent running state is decided only by visible phase boundaries: it is `in_progress` while it is the last visible chunk of a running work segment, otherwise `completed`.
- The child's running/completed/failed/stopped does not decide the parent state in reverse; an error is shown only on the corresponding child.
- A hidden non-first reasoning is not a boundary; visible reasoning, Explore, Terminal, Agent, text and other visible tools all end the current Changes.
- The parent key/tool id is anchored to the first real file-write row; adding a child must not rebuild the parent component or lose its expanded state.

## Summary contract

| Parent state | Expansion | Summary                                                                                                |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| in progress  | collapsed | `Changes · N files · Editing/Writing <file chip> <diff count>`; the latest snapshot scrolls vertically |
| in progress  | expanded  | `Changes · N files`                                                                                    |
| completed    | expanded  | `Changes · N files`                                                                                    |
| completed    | collapsed | multiple files: `Changes · N files · <file chips>`; single file: `Changes · <file chip>`               |

When a running Write/Edit has entered the group but the streamed JSON does not yet provide a parsable file path, the parent summary shows `Changes · N tools`, where N is the current number of group children. At this stage it must not show a dangling separator or `0 files`; after expansion the original children are still kept, even if the path has not arrived and only `Writing`/`Editing` can be shown for now. Once the path arrives the parent summary switches to the normal file summary.

- The file count is de-duplicated by normalized full path, in first-appearance order; when a single Edit carries several file summaries they are flattened first and de-duplicated together with the other children.
- When completed and collapsed with only one unique file, `1 file ·` is omitted and the file chip is shown directly; this is the compact exception for a single-file summary.
- When completed and collapsed, first render the full file chip list, then keep as many leading chips as the summary's actually available width allows, and show `+N` for the rest; `ResizeObserver` recomputes when the desktop window, sidebar or mobile layout width changes, and restores more files when it widens. The container must not overflow horizontally. Chips reuse the existing file icon, tooltip and code-preview click behavior.
- When running and collapsed, the latest child with a file summary is used; the action is decided by that child's operation semantics.
- The running `N files` is de-duplicated live by currently parsed paths; action, file name, path and diff count belong to the same dynamic content level and are separated only by normal spacing without `·`. `·` only separates Changes, the file total and the dynamic content.
- The running scroll snapshot must also store that child's diff count. After the file summary switch completes, the diff number flips independently at the tail of the same snapshot; it must not show the next child's statistics early, nor mount the final value only after the child completes.
- While the parent is expanded, the child Write/Edit diff count must keep the entry animation of the first streamed statistics; grouping must not degrade the running process into a static final statistic shown after completion because a child mounts late.
- Expanding stops the parent summary animation immediately and shows the unique file count; the current action is expressed by the child summary below.
- The Changes parent uses a fixed 16px pencil icon; it stays static while running and does not switch to a loading spinner.
- The file name of the file chip shared by Edit and Changes uses `text-foreground-subtle`; the relative directory keeps the lower level `text-foreground-subtlest`.

## Multi-client boundary

Grouping consumes only the same rows finally projected by desktop continuous or web-remote replayable and does not change transport, snapshot, gap, queue or owner semantics. The shared renderer serves desktop and mobile Web; narrow screens protect the layout via `min-w-0`, truncation and a fixed chip cap.
