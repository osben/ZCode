---
name: handoff-to-zcode
description: Use when the user wants to hand a prepared implementation plan to the ZCode desktop app. Writes the plan to <project>/.zcode/handoff/<id>.md and builds a zcode://task/new link that opens the project in ZCode with the plan in a new, unsent composer draft.
---

# Handoff to ZCode

ZCode registers `zcode://task/new?path=<abs-dir>&promptFile=<abs-file>`. Opening it shows a confirmation with a preview, opens the
project and fills a fresh draft with the file's text. It never sends; the user reviews and presses Send. Spec: `specs/deeplink-new-task.md`.

Install for other harnesses by copying this folder to `~/.claude/skills/` (Claude Code) or the equivalent skills directory.

## Steps

1. **Write a precise plan** (self-contained; the ZCode agent has no access to this conversation):
   - Goal and the user-visible outcome, in 2-3 sentences.
   - Files to touch, with paths relative to the project root and what changes in each.
   - Ordered implementation steps; call out constraints, interfaces and decisions already made.
   - Acceptance criteria: commands to run (typecheck, tests) and observable behavior.
   - Plain UTF-8 markdown, at most ~7 000 characters (hard limit 8 000 characters, 256 KiB file).
2. **Save it** to `<project>/.zcode/handoff/<id>.md`, where `<id>` is a short unique slug such as `20261019-1530-auth-refactor`. Create the directories.
   The file must be inside the project: files outside it (or symlinks leaving it) are rejected. Never put secrets in the plan.
3. **Build the link** with absolute paths:
   ```bash
   node <skill-dir>/scripts/build-link.mjs "<abs project>" "<abs project>/.zcode/handoff/<id>.md"
   ```
   The script URL-encodes both paths and refuses plans outside the project.
4. **Print the link** as a clickable markdown link, plus the file path. On macOS also offer: `open "<url>"` (quote it).
   Do not put a long plan into `prompt=`; use `promptFile`. Use `prompt=` only for a one-line task (URL-encoded, max 8 000 characters).
5. Tell the user ZCode will ask for confirmation and will only fill the draft. Do not claim the task has started.

## Notes

- Add `.zcode/handoff/` to `.gitignore` if the project does not track it.
- The ZCode app must be installed and registered for the `zcode://` scheme (dev builds: `docs/desktop/dev-deep-link.md`).
- If the project is already open in another ZCode window, the draft goes to that window.
