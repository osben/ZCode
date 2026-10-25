# Changelog

Changes in this fork compared to upstream zai-org/ZCode.

## Unreleased

Based on upstream v3.15.1, with the v3.15.2 auth fix and the v3.15.3 auto-update improvements ported in.

### Added

- ChatGPT sign-in: log in with a ChatGPT Plus/Pro account and run the agent on that plan.
- Voice dictation: local transcription with a model catalog, verified downloads, idle unload, a recording panel, start/stop chimes, and an option to mute system audio while recording. Works in packaged apps.
- Web and mobile remote: a self-hosted relay server, a Railway-ready page for the remote UI, opening files and apps on the desktop from the phone, creating and opening worktree workspaces remotely, voice dictation in the browser, and a private-chat-only `/remote` bot command that mints a web-remote link for a bound workspace open on the desktop, reuses an active remote runtime, and reconnects an eligible remote workspace before returning the link.
- Appearance: bundled Inter Variable UI and JetBrains Mono code/terminal fonts, with custom installed font choices that apply across app windows.
- Workspace sidebar: pin projects, customize their display names and icon colors, and open GitHub repositories from the project menu.
- Git worktrees: "New task in worktree" in the Command Center, worktree settings, pruning, and an execution worktree created automatically on first send.
- Message pins: pin a message; pinned chips above the timeline jump to it.
- Output styles: editable style prompts, overrides in `~/.zcode/output-styles/`.
- System prompts: an inline editor in Settings with validation warnings, diffs against defaults, revisions, external-change conflict handling, and an assembled preview; overrides live in `~/.zcode/system-prompt/`, and Memory Extraction and Dream prompts are editable too.
- Instructions editor: edit the global `~/.zcode/AGENTS.md` from Settings.
- Resume button on the chat error banner.
- Coding Plan auto-continue after a quota reset.
- Memory viewer v2 in Settings: file types and descriptions, inline previews, an index budget chip, folder access.
- Themes: 10 accent palettes with tinted surfaces, a terminal WebGL toggle, and a theme picker in the Command Center.
- Ukrainian localization (uk-UA).
- Sidebar: merged-branch badge, task hover cards, child conversations with running subagents, and the Model trajectory tab in the launcher.
- Live tok/s in session status rows.
- Sessions manager: a full-screen table to search, filter, open, and bulk archive or delete sessions across a project's workspaces, with an opt-in "Erase permanently" that purges a session and its child sessions.
- Review pane: group changed files by directory, with a toggle back to the flat list.
- ChatGPT Plan: connect multiple ChatGPT accounts in parallel and track each account's usage windows.
- Manual `/dream` command that consolidates project memory on demand; Settings shows the last run time.
- ACP agents: run external ACP-compatible agent CLIs as providers, with detection, login, and a raw-frame test in Model Settings. Available only in local development runtimes while the feature stabilizes.
- Release pipeline for the fork with `-fork.N` versions and production-backend release builds.
- Pre-commit hook that formats and lints staged files and rejects staged files above 20,000 bytes, with exemptions for lockfiles and declared generated files.
- Deep links: `zcode://task/new` opens a project with the prompt pre-filled in the composer as a reviewable draft, routed to the window that already owns the project; nothing is sent automatically.
- Incognito sessions: a composer toggle starts a clean chat without project instructions, skills, hooks, plugins, MCP, or memory, with per-capability defaults in Settings.
- Nested AGENTS.md: a tool call that touches a subfolder delivers that folder's AGENTS.md as a reminder inside the tool result.
- LSP integration: post-edit diagnostics, an LSP tool, and a bundled TypeScript language server plugin.
- Live token accounting: subagent tool rows show cumulative input/output tokens and elapsed time, tool calls show stage durations and per-turn output tokens, and the context window breakdown shows estimated tokens per section.
- Usage stats: long-lived history with date-range filters, an hourly activity heatmap, detailed metrics, and data export.
- Resource telemetry toggle in Settings → General (desktop, off by default) that stops local resource sampling.
- OAuth: the browser callback page shows a styled success/error card with an "Open ZCode" button.
- Git: a confirmation before committing on a detached HEAD, and the composer defaults the worktree Base branch to main when worktree mode turns on.

### Fixed

- GLM-5.3 404 on Coding Plan plans: coding-plan traffic now connects directly.
- Plan details now open from side chats.
- ChatGPT Plan models stay selectable alongside other account-backed providers and honor their configured reasoning defaults.
- Interactive controls show a pointer cursor consistently.
- Keyboard shortcut labels render arrow keys as arrow glyphs.
- "Open in Editor" finds JetBrains Toolbox installs and Android Studio.
- The context meter shows the real compaction thresholds.
- `.text` files no longer break the file icon in packaged apps.
- Gen UI vendor assets keep exact bytes on Windows checkouts.
- Session databases from before the fork still load.
- Web client: task lists from a standalone server load again.
- Custom TLS certificates no longer disable trust for public CAs.
- Git: session rows no longer show misleading merge indicators.
- Side chats no longer steal focus from the main composer when pickers open.
- Stray Enter and digit keys no longer confirm destructive dialogs or approve tool calls, failed inline edits keep their draft, and sidebar row archiving needs a second confirming click.
- Worktrees: safer branch switching, auto-refresh on external repository changes, real failure reasons on retry, and a retry that starts Git setup reliably even when the host snapshot arrives before its acknowledgement.
- New terminals open in the session's execution worktree instead of the workspace root.
- The `/plan` shortcut no longer drops attachments and structured context, and two chats created at once no longer reuse each other's worktree preparation.
- Forking a conversation keeps the inherited model selected in the composer, and subagent model overrides survive background sync while being edited.
- Stale Dream lock leases expire instead of blocking future memory consolidation.
- ACP agent processes are fully terminated on stop and restart, with an accurate error when a handshake dies.
- The server expires unclaimed remote connections instead of leaking them, and Coding Plan token refreshes are single-flight, ending refresh races and unexpected sign-outs.
- Failed deferred Picture-in-Picture permission prompts are retried instead of dropped, and subagents in side chats open in the correct pane when clicked.
- Composer submissions freeze and deliver exactly once per attempt, and off-scale font sizes and raw colors are replaced with design tokens.

### Changed

- CI: parallel test jobs with a V8 compile cache, Node 26 and Ubuntu 26 runners, CodeQL fixes. PR checks went from about 12 to about 9 minutes.
- Dependency updates: React 19.3, vitest 4.1.7, and safe batch updates.
- AGENTS.md, code comments, and specs translated to English.
- Memory index: tail-biased elision keeps the injected index small, with opt-in background-context framing.
- Performance: the CLI materializes its Bash command registry on demand and amortizes usage-retention pruning.
- Performance: session and task switching up to 60-70% faster through a binary MessagePort fast path, cold start about 35% faster by letting the storage-prep worker exit promptly, fewer redundant re-renders while streaming, and lighter task index reads.
- Git hooks: Lefthook replaces Husky; `pnpm prepare` installs the pinned version and older worktree checkouts get compatibility shims.
- Pre-push: documentation-only changes skip the Node test stages, and stage timings are reported.
- Formatting: `pnpm fmt` / `pnpm fmt:check` cover only files changed since the pinned upstream base, so upstream-identical files are never reformatted.
- Settings navigation is regrouped, and the unreachable migration section is hidden.

### Upstream

- v3.15.1 baseline merge.
- v3.15.2 auth fix.
- v3.15.3 auto-update improvements (ported).
