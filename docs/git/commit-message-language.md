# Git Commit Message Language Generation Specification

## Background

AI-generated Git commit messages follow the current UI language. When the user selects a fixed language, that language is used; when the user selects "system default", the caller passes the already resolved real language.

## Rules

- Only Chinese and English generation languages are supported.
- `zh-CN` generates a Chinese subject / body; `en-US` generates an English subject / body.
- When the current language cannot be obtained, or it is not Chinese, fall back to English.
- Conventional Commit type / scope syntax stays English, for example `fix(git): 修复提交消息语言`.

## Data Flow

- UI reads the resolved `locale` through `useZCodeIntl()`.
- The Git commit message generation request passes `locale` to the service layer.
- The request also carries recent text context of the current session; language rules still follow `locale`, and session context is used only to understand the intent of the change.
- If the current session has a file modification summary, UI also passes `currentSessionFilePaths`; the service layer generates the commit message only from the staged/unstaged changes and diffs matching those files, so other workspace changes do not pollute the topic.
- The staged/unstaged file list in the commit popup is filtered by the same session file summary; when "include unstaged changes" is checked, only unstaged changes of current session files are staged and committed.
- The action area at the bottom of the commit popup is a Command list carrying "commit / commit and push / push"; the selected action is triggered by the primary modifier plus Enter (Command on macOS, Ctrl on Windows/Linux).
- The service layer normalizes the language and writes it into the model prompt.
- For old calls that do not pass `locale`, the service layer tries the runtime Intl locale, then falls back to English.

## Acceptance

- Under Chinese UI, the generated prompt includes `Current language: Chinese`.
- Under English UI or unknown language, the generated prompt includes `Current language: English`.
- When the current session has a file modification summary, the prompt's `Changed files` / `Diff excerpts` come only from current session files.
- When the current session has a file modification summary and "include unstaged changes" is checked, commit request paths include only current session files.
- After switching the selected bottom action in the commit popup, primary modifier plus Enter triggers the corresponding action.
- Model output must still pass the Conventional Commit first-line validation.
