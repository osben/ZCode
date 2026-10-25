# Session title polish

Status: proposed (iteration 1 of 2). Iteration 2 (a bounded retry after a failed generation, and titles for
selection side chats) is out of scope here and gets its own spec after this one ships.

Related: `docs/ui/task-title-authority.md` (priority and ownership), `apps/zcode-cli/docs/design/v2/session-title-generation.md`
(upstream design), `specs/upstream-sync-cli-divergences.md` (every CLI change below is listed there).

## 1. Problem

Three small defects make new session titles worse than they need to be.

1. **Mention markup leaks into the title.** The title seed is the user's message as typed. Composer mentions
   serialize to Markdown links (`[$skill](/abs/path/SKILL.md)`, `[@Plugin](plugin://id@market)`,
   `[a.ts](./src/a.ts)`, `[#label](#sess_x)`), so the 60-character first-input title and the
   input of the title model start with a path instead of the task. The TUI and headless `/skill name task`
   submit `buildManualSkillPrompt(...)` verbatim as the prompt, so the title is the English template
   ("Use the skill named ...") instead of the task.
2. **Non-Latin generated titles are discarded.** `cleanGeneratedTitle` requires one of
   `[A-Za-z0-9㐀-鿿]`. A title that is only Cyrillic, kana, Hangul or Arabic is rejected and the session
   keeps the truncated first input. `uk-UA` is a shipped locale.
3. **An empty rename is storable.** The sidebar dialog and the header rename do not guard an empty draft. The
   Host writes the overlay and `titleOverridden=true` before the CLI command, and swallows a CLI failure, so an
   empty `custom` title permanently disables auto-titling and the Host and CLI disagree.

## 2. Product rules

### 2.1 Title seed

The _title seed_ is the copy of the first user input used only to (a) build the first-input title,
(b) decide whether generation is attempted (10 code point minimum), and (c) build the title model request.
The persisted user message and the model-facing prompt are never changed.

`sanitizeTitleSeed(input)` rewrites, in order:

| #   | Input form                                                                                                                            | Seed                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | `buildManualSkillPrompt` template followed by `User request:\n<task>`                                                                 | `<task>`                    |
| 1   | same template followed by the "No additional user request" block                                                                      | `$<skillName>`              |
| 2   | `[label](plugin://...)`                                                                                                               | label without a leading `@` |
| 2   | `[label](#sess_...)`                                                                                                                  | label without a leading `#` |
| 2   | `[$label](path)`                                                                                                                      | `$label`                    |
| 2   | `[label](dest)` with a path-like destination (`/`, `./`, `../`, `C:\`, `file:`) not preceded by a word character (files, directories) | label without a leading `@` |
| -   | other links (`https://...`) and code such as `handlers[type](payload)`                                                                | unchanged                   |
| 3   | bare `#sess_<id>` token                                                                                                               | removed                     |
| -   | everything else, including `/custom-command args`, `@subagent`, `$skill`, `/goal`                                                     | unchanged                   |

Safety rules:

- Whitespace is not collapsed by the sanitizer (the template match needs the newlines). Callers collapse after.
- If the result is empty after trimming, the original input is returned.
- Pure and idempotent. The template match is anchored to the exact three fixed lines; any drift in the CLI
  template makes rule 1 not match and the input passes through unchanged (today's behavior).
- Custom commands already persist the typed text as `displayInput`; the expanded template never reaches the
  title and stays that way.
- Subagent, fork and automation sessions are not auto-titled; unchanged.

### 2.2 Generated title acceptance

A cleaned generated title is accepted if it contains at least one Unicode letter or number (`[\p{L}\p{N}]`, `u`
flag). Length cap, quote stripping and punctuation trimming are unchanged.

### 2.3 Rename

- An empty or whitespace-only title is ignored: no overlay write, no index write, no CLI command, no error toast.
- The CLI handler treats an empty title as a no-op, so an older Host that still sends it cannot create an empty
  `custom` title.
- No length limit is added (callers such as automations and bots store longer strings today).
- `setCustomSessionTitle`, the protocol schema and persisted data are unchanged.

## 3. Owners and interfaces

| Concern                     | Owner                                                                                                                    | Change                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Seed sanitizer              | `packages/shared/src/zcode-session-visible-content.ts` (existing title-text helpers; exported from `@zcode/shared`)      | new pure function `sanitizeTitleSeed`      |
| First-input title           | `core/src/runtime/methods/events.ts` (2 call sites)                                                                      | `titleFromInput(sanitizeTitleSeed(input))` |
| Generation gate and request | `core/.../session-title.ts` (length check), `title-generation-sidecar.ts` (`buildTitleMessages`)                         | sanitize before `normalizeTitleInput`      |
| Title acceptance            | `title-generation-sidecar.ts` `cleanGeneratedTitle`                                                                      | `\p{L}\p{N}` check                         |
| Rename guard                | `packages/services/.../zcodeTaskServiceAdapter.ts` `renameTask`; dialogs in `packages/ui`; CLI `session-mgmt.ts` handler | trim + early return                        |

Explicitly untouched: `normalizeTitleInput` and `titleFromInput` themselves (also used by `/goal` summaries and by
code identical to upstream), `setCustomSessionTitle`, SQLite schemas, protocol schemas, `settings.json`.
There is one write path per layer; no state is added.

## 4. Acceptance scenarios

1. First input `[$brainstorming](/home/u/.skills/brainstorming/SKILL.md) design a cache` creates the first-input title
   `$brainstorming design a cache`; the model request body contains no path.
2. `/skill brainstorming design a cache` from the TUI creates the title `design a cache`; `/skill brainstorming`
   alone creates `$brainstorming`.
3. `[@Linear](plugin://linear@official) list my issues` creates `Linear list my issues`.
4. `see [a.ts](./src/a.ts) and #sess_abc123` creates `see a.ts and`.
5. A message that is only `#sess_abc123` keeps the original text as the title (empty-result fallback).
6. `/review src/a.ts` (custom command) and `@explorer find X` keep their typed text.
7. A model reply `{"title":"Налаштування кешу"}` is accepted; `{"title":"..."}` and `{"title":"!!!"}` are not.
8. Renaming to `""` or `"   "` from the sidebar, the header and the session manager changes nothing on the Host or the
   CLI and shows no error; a later first-turn auto title still happens.
9. The Host `renameTask("")` and a CLI `renameSession {title:""}` both leave the previous title and its source.
10. `/goal` and `/workflow` first inputs title exactly as before.

## 5. Verification

- New unit tests: `shared/test/sessionTitleSeed.test.ts` (every row of 2.1, idempotence, empty fallback, template drift),
  `core/tests/title-generation-clean.test.ts` (`cleanGeneratedTitle` cases (Cyrillic, kana, symbols only), CLI rename no-op, Host `renameTask` early return.
- A `cli` package test builds `buildManualSkillPrompt(...)` and asserts the sanitizer recognizes it.
- Baseline before the edit and after: `core` `off-peak-title`, `runtime-persistence`; `bootstrap` `session-persistence`,
  `product-projection`, `zcode-protocol`; `adapters` `session-store`.
- Root `pnpm typecheck` and `pnpm lint` do not cover `apps/zcode-cli`; run that package's own `typecheck`, `lint`
  and `test` as well, and `pnpm architecture:check --changed`.
- Rename dialogs: reuse an existing rename E2E if one exists; otherwise the guard is covered by a component/unit
  test and the report says no E2E was added.
