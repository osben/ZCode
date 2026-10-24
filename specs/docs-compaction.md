# Documentation compaction and English-only docs

## Goal

Docs and specs describe the current product in compact English. History lives in git, not in the
document. This spec is the rubric for the compaction series and for later doc edits.

## Scope

In scope: `specs/`, `docs/` and `apps/zcode-cli/docs/` markdown, root and package `README.md` files.

Out of scope (never edited by the series):

- Markdown that code reads at runtime or that tests parse: plugin and skill packages under
  `apps/zcode-cli/packages/`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRACT.md`, test fixtures, and
  docs read by tests or scripts (for example `docs/testing/conversation-session-*`,
  `docs/conversation-session-case-catalog.md`,
  `docs/monitoring/{process-resource-telemetry,performance-telemetry-catalog}.md`).
- Vendored content (`docs/knip/`), licenses, notices, `CHANGELOG.md`.
- `.agents/` and `.claude/` skills: they are agent behavior, not documentation.

## Rules

1. **Paths are stable.** Compact a file in place. Do not rename, move or merge files. Delete a file only
   when no tracked file references its path (`git grep -F <path>` and `git grep -F <basename>` return
   only the file itself) and its content is fully historical: a finished implementation plan, a
   superseded draft, a working note for shipped work. Every deletion is listed with its reason in the
   PR body.
2. **Keep the contract, drop the narrative.** Keep product rules, state owners, interfaces, event
   order, invariants, acceptance scenarios, known limitations and open follow-ups. Remove changelog
   prose ("in this change we…"), repeated explanations, step-by-step implementation diaries, resolved
   review threads, and code that the repository already contains. Merge sections that restate the
   same rule; fold "improvements in this change" into the current-state rule they changed.
3. **Ledgers keep their outcome.** A finished sync or audit ledger keeps its final state, open items
   and decisions, plus one line naming the commit that holds the full pre-compaction version
   (`Full history: git show <sha>:<path>`).
4. **Translate prose to English.** Keep verbatim: code blocks, inline code, identifiers, file paths,
   CLI commands, config keys, error strings, log messages, regexes, test names, and quoted UI copy
   (zh-CN or uk-UA strings that tests or locales assert on stay in the original, optionally followed
   by an English gloss).
5. **References keep working.** Section headings and numbers referenced from elsewhere (`§4`,
   `#anchor`, "section 11.1") keep their number and meaning. When a heading is translated, update every
   `#anchor` link that points to it. Relative links must resolve after the edit.
6. **Plain style.** Short sentences, present tense, no filler, no emoji. Tables and lists only where
   they carry structure. Do not add new content or opinions; when the document contradicts the code,
   keep the document's statement and report the contradiction instead of guessing.

## Verification

Each batch passes the series verifier (links, anchors, references from non-markdown files, residual
CJK outside allowed literals, byte delta), `pnpm fmt` on touched files, `pnpm lint` and
`pnpm typecheck`. Reviewers spot-check that every acceptance scenario and owner/interface section in
the old version still has a counterpart in the new one.
