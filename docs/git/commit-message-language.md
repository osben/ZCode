# Git Commit Message Language Generation Specification

Update date: 2026-07-07

## Background

When AI generates Git commit messages, it needs to follow the current UI language. When user selects a fixed language, directly use that language; when user selects "system default", the caller must pass in the already resolved real language.

## Rules

- Only Chinese and English generation languages are currently supported.
- `zh-CN` generates Chinese subject / body.
- `en-US` generates English subject / body.
- When current language cannot be obtained, or language is not Chinese, uniformly fallback to English.
- Conventional Commit type / scope syntax remains English, e.g. `fix(git): 修复提交消息语言`.

## Data Flow

- UI reads current resolved `locale` through `useZCodeIntl()`.
- Git commit message generation request passes `locale` to service layer.
- The same request also carries current session recent text context; language rules still take `locale` as basis, session context only used for understanding modification intent.
- If current session already has file modification summary, UI also passes `currentSessionFilePaths`; service layer only uses staged/unstaged changes and diff matched from those files to generate commit message, avoiding other workspace changes polluting the topic.
- Staged/unstaged file list in commit popup is also filtered using same current session file summary; when checking "include unstaged changes", only stage and commit unstaged changes corresponding to current session files.
- Action area at bottom of commit popup uses Command list to carry "commit / commit and push / push"; currently selected action can be triggered by main shortcut key plus Enter, macOS uses Command, Windows/Linux uses Ctrl.
- Service layer normalizes language then writes into model prompt.
- For old calls not passing `locale`, service layer tries to read runtime Intl locale; if still unavailable, uses English.

## Acceptance

- Under Chinese UI, generated prompt includes `Current language: Chinese`.
- Under English UI or unknown language, generated prompt includes `Current language: English`.
- When current session exists file modification summary, generated prompt's `Changed files` / `Diff excerpts` only come from current session files.
- When current session exists file modification summary and "include unstaged changes" is checked, commit request paths only include current session files.
- After switching selected bottom action in commit popup, main shortcut key plus Enter triggers corresponding action.
- Model output still must pass Conventional Commit first line validation.
