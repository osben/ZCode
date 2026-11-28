# Rust agent: ZCode Desktop Context in the environment announcement

Status: implemented in zcode-rs (`packages/rust-cli`). Node oracle: `docs/desktop/zcode-desktop-context.md`, core `context/sections/desktop.ts`, `context/sections/env-info.ts` (`buildEnvironmentAnnouncement`, `desktopContextText`) and `runtime/methods/context-refresh.ts` (`withDesktopContext`). Parity row: `specs/fork-rust-agent-parity.md`, "ZCode Desktop Context system section".

## Background

Node 3.17.2 put the "ZCode Desktop Context" section in the system prompt. Node 3.18 moved it out: the presentation surface and the server-side rollout are process-level facts and the Gen UI directory changes per session, while the system prompt is frozen until compaction. The text now rides the environment announcement, so a change is appended as an update and the prefix already sent never changes.

zcode-rs followed 3.17.2 (a section closing the static system block, cached per session). This spec moves it to Node's 3.18 form.

## When the part exists

The part exists in a request of the main thread when all of these hold (Node `ContextBuilder` adds the `desktop_context` section, and `withDesktopContext` copies the answer into the announcement):

- the app-server runs with `--surface desktop` (`ContextConfig::desktop` is Some);
- no `--system-prompt`;
- the incognito profile keeps `harness` (the profile drops `environment` as a whole, which also drops the announcement, so the part goes with it);
- not a subagent or a workflow actor: no request with an agent id or a `Subagent` source, and none of a child's auto-compaction. Node children do not inherit the surface or the root.

## Text

Node `buildDesktopContextContent(hasGenUiOutputDirectory)`, lines joined with a newline:

- with a Gen UI directory: `# ZCode Desktop Context`, a blank line, the `### Interactive views` block (four bullets, then a blank line), then `### Files & URLs` and `### Inline Code Comments`;
- without one (no `ZCODE_GEN_UI_OUTPUT_ROOT`): the same without the Interactive views block. There is no "unavailable" substitute line.

The second Interactive views bullet now reads: `The writable, durable visualization directory for this session is listed in the environment. Save inline fragments there, outside the project. Other paths cannot be rendered.` The directory itself is no longer in the text.

The system prompt holds no Desktop text. The static block is cached `scope: global` again, as for any session. `/context` no longer lists a "ZCode Desktop Context" system row (Node counts the announcement with the other attachments).

## Announcement

Snapshot (the `environment` attachment's `data.snapshot`) gets two optional keys with Node's names: `desktopContext` (true) and `visualizationDirectory`. A snapshot without them (written by an older build) counts as "none".

Full block:

- after the additional directories and before `Platform`: ` - Visualization directory for this session: <path>`, only with a directory;
- after the last bullet (the untrusted-downloads line): a blank line and the Desktop text, only when `desktopContext`.

Update, when a full block was sent earlier and the host is unchanged:

- lines, in order: working directory, git, additional directories added and removed, then ` - Visualization directory for this session: <path or none>` with ` (was <old>)` when there was one;
- the Desktop part compares by form (none, with a directory, without): a changed form appends the new Desktop text, or, leaving the desktop, `The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.`;
- the bullet lines keep the `# Environment update` heading; the Desktop text follows after a blank line; when only the Desktop part changed, the update is that text alone, with no heading.

A new full block follows a compaction boundary or a platform, shell or OS change (the existing rule). `changes` in the attachment data marks an update; a Desktop-only update has `{"field": "desktopContext"}`.

## Gen UI directory

Unchanged: `desktop::Directories` binds the directory to the session on its first request and creates it on the primary env before it is first named; a failure fails the request. The call now sits where the announcement is built (`turn_attachments`), so the request still fails before the model is called.

## Known differences from Node

- Node's fork writes the child's environment update (its own directory, and its cwd for a managed worktree) into the child's history when it is created (`buildChildEnvironmentUpdate`). zcode-rs writes nothing at fork time: the child's first announcement compares against the copied history and sends the same directory line then. A fork into a managed worktree gets the new working directory the same way.
- Node treats a shell change as an update line; zcode-rs resends the full block (existing behavior).
- The directory is escaped like the other environment paths (`<`, `>` and control characters); Node writes it raw.

## Acceptance

Tests (`context` `desktop_tests.rs`, `environment_tests.rs`, `system_tests.rs`, `lib_tests.rs`):

1. both texts equal Node's lines, byte for byte, including the new second bullet and the omitted block without a directory;
2. the full block: the visualization bullet before `Platform`, and the Desktop text after a blank line at the end; a snapshot without the keys round-trips;
3. updates: form change in both directions, leaving the desktop (the "no longer applies" line), desktop-only (no heading), desktop with bullet lines (blank line between), directory change line with and without a previous value, an unchanged part adds nothing;
4. the system blocks hold no Desktop text on any request, and the static block is `scope: global`;
5. a main-thread `turn_attachments` on the desktop announces the part; a subagent request, a child's compaction, a custom prompt and an incognito profile without `harness` do not; the directory is created by `turn_attachments` and a refused creation fails it.
