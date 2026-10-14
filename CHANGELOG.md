# Changelog

Changes in this fork compared to upstream zai-org/ZCode.

## Unreleased

Based on upstream v3.15.1, with the v3.15.2 auth fix and the v3.15.3 auto-update improvements ported in.

### Added

- ChatGPT sign-in: log in with a ChatGPT Plus/Pro account and run the agent on that plan.
- Voice dictation: local transcription with a model catalog, verified downloads, idle unload, a recording panel, start/stop chimes, and an option to mute system audio while recording. Works in packaged apps.
- Web and mobile remote: a self-hosted relay server, a Railway-ready page for the remote UI, opening files and apps on the desktop from the phone, creating and opening worktree workspaces remotely, voice dictation in the browser, and a `/remote` bot command that creates remote-control links.
- Git worktrees: "New task in worktree" in the Command Center, worktree settings, pruning, and an execution worktree created automatically on first send.
- Message pins: pin a message; pinned chips above the timeline jump to it.
- Output styles: editable style prompts, overrides in `~/.zcode/output-styles/`.
- System prompt overrides: replace whitelisted system prompt sections with files in `~/.zcode/system-prompt/`.
- Instructions editor: edit the global `~/.zcode/AGENTS.md` from Settings.
- Resume button on the chat error banner.
- Coding Plan auto-continue after a quota reset.
- Memory viewer v2 in Settings: file types and descriptions, inline previews, an index budget chip, folder access.
- Themes: 10 accent palettes with tinted surfaces, a terminal WebGL toggle, and a theme picker in the Command Center.
- Ukrainian localization (uk-UA).
- Sidebar: merged-branch badge, task hover cards, and the Model trajectory tab in the launcher.
- Live tok/s in session status rows.
- Release pipeline for the fork with `-fork.N` versions and production-backend release builds.
- Pre-commit hook that formats and lints staged files.

### Fixed

- GLM-5.3 404 on Coding Plan plans: coding-plan traffic now connects directly.
- Plan details now open from side chats.
- "Open in Editor" finds JetBrains Toolbox installs and Android Studio.
- The context meter shows the real compaction thresholds.
- `.text` files no longer break the file icon in packaged apps.
- Gen UI vendor assets keep exact bytes on Windows checkouts.
- Session databases from before the fork still load.

### Changed

- CI: parallel test jobs with a V8 compile cache, Node 26 and Ubuntu 26 runners, CodeQL fixes. PR checks went from about 12 to about 9 minutes.
- Dependency updates: React 19.3, vitest 4.1.7, and safe batch updates.
- AGENTS.md, code comments, and specs translated to English.

### Upstream

- v3.15.1 baseline merge.
- v3.15.2 auth fix.
- v3.15.3 auto-update improvements (ported).
