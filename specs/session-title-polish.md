# Session title polish

Status: iteration 1 (sections 1-5) shipped in osben/ZCode#355. Iteration 2 (section 6: a bounded retry after a
failed or skipped generation, and titles for selection side chats) is specified below and not implemented yet.

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

The reply is read as title JSON in this order: the whole reply, the first fenced code block anywhere in the reply
(a lead-in line such as `Here is the title:` is allowed), then the span from the first `{` to the last `}` when it
parses with a string `title`. Only when none of them yields a title does the first non-empty line become the candidate. This diverges
from upstream, whose fenced match must span the whole reply.

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
8. Renaming to `""` or `"   "` from the sidebar (flat and grouped lists), the header and the session manager changes
   nothing on the Host or the CLI and shows no error; a later first-turn auto title still happens.
9. The Host `renameTask("")` and a CLI `renameSession {title:""}` both leave the previous title and its source.
10. `/goal` and `/workflow` first inputs title exactly as before.
11. A model reply `Here is the title:` + a fenced `{"title":"Bug fix"}` block creates `Bug fix`, and so does
    `Title: {"title":"Bug fix"}`; neither becomes `Here is the title` or the raw JSON line.

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

## 6. Iteration 2: bounded retry and side chat titles

### 6.1 Problem

- Generation runs once per runtime (`sessionTitleGenerationAttempted`, in memory). A timeout, an empty model reply, an
  input under 10 characters (`hi`) or an empty/attachment-only first message leaves the first-input title
  (`Untitled session`, `hi`, a truncated sentence) for the whole session.
- Selection side chats are created with the fixed title `Selection side chat` (source `generated`) and are never
  generated: the gates `parentSessionId`, `taskType !== "interactive"`, the stored `parentID` check and
  `turnNumber !== 0` (a side chat resumes with the copied parent history, so its turn counter is not 0) all reject them.
  The sidebar lists side chats under their parent with the stored title.

### 6.2 Product rules

- A runtime makes at most **2** title generation attempts (`MAX_SESSION_TITLE_GENERATION_ATTEMPTS`). Only attempts that
  reach the model count; the cheap "title is already resolved" check does not.
- The first attempt keeps today's rules (new interactive session, first turn, input of at least 10 code points after
  the title seed sanitizer, `/goal` bypasses the length guard).
- A later user message starts a **retry** when all hold: attempts < 2, none in flight, the runtime is not
  _settled_, the message seed has at least 10 code points, and the persisted title is still auto-pending:
  `titleSource` is `default` or `first_input`, or the session is a selection side chat whose generated placeholder
  has no `titleMessageID` yet.
- The retry seed is the first seed this runtime saw (first user input of this runtime, with its message id) when it has
  at least 10 code points, otherwise the current message. After a cold resume the first seed is simply the first
  message sent in the new runtime.
- _Settled_ (no more attempts, in memory): a generated title was persisted, the persisted source is `custom` or already
  generated, a retry found the title not pending, the first query was edited, or the user renamed the session in this
  runtime. A rename therefore stops retries for good.
- Writes keep the existing guards: `expectedTitleSources` CAS, the `custom` short circuit and the first-query-edit
  suppression with the seed's message id. A retry never replaces a generated or custom title.
- Selection side chats are eligible for generation (store `taskType === "selection_side_chat"` with a parent).
  Their first user question after the boundary is the seed (the selected text arrives as a model-boundary quote
  and is not part of the seed). A side chat is created with a `generated` placeholder title and no `titleMessageID`;
  a title written by the sidecar always records its message, so "auto-pending" is `titleSource` `generated` with no
  `titleMessageID` (no title text is compared). Forks (`Fork of ...`), subagents, workflow children and automations stay excluded.
- `/goal` input (a call with `goalSummaryTargetID` or the short-input bypass), external-agent turns and model-only inputs
  never retry; the `/goal` path is first-turn-only exactly as before, so its goal summary fallback still runs.
- The post-turn deferred start for providers that need a runtime-header refresh is unchanged and also serves retries:
  when the pre-turn call is deferred, the same call is repeated after the turn and starts the attempt then.

### 6.3 Owners and interfaces

| Concern                                              | Owner                                                             | Change                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Attempt counter, in-flight, settled, remembered seed | `AgentRuntime` private fields (`internal.ts`, `agent-runtime.ts`) | replace the boolean attempt flag; the seed is sanitized, at most 1200 chars, kept only for title-capable runtimes; no persisted state |
| Mode decision (`first` / `retry` / none)             | `core/src/runtime/methods/session-title.ts`                       | `resolveSessionTitleGenerationMode`                                                                                                   |
| Pending-title check and session eligibility          | same file (`isTitleEligibleSession`, `isAutoTitlePending`)        | used by generation and by the persist re-read                                                                                         |

Event order: user message persisted -> mode decision (sync, in memory) -> attempt starts (in flight) -> store re-read
(eligibility, pending) -> model call -> CAS write of `generated` -> `SessionTitleUpdated` -> settled. A child side chat
session's event already refreshes the parent sidebar summary (`onChildSessionActivity`).
No schema, protocol or `settings.json` change; titles stay in `title`, `title_source`, `title_message_id`.

### 6.4 Acceptance scenarios

1. Attempt 1 returns an empty reply; the next message (12+ characters) retries with the first message as the seed and
   the title becomes generated. A third message makes no model call.
2. First message `hi`: no attempt. The second message `please add dark mode` generates a title from it.
3. A user renames the session after a failed attempt; the next message makes no model call and the title stays.
4. A generated title already exists after a cold resume: the next message does a store read, no model call.
5. A first attempt is still in flight when message 2 arrives: no second attempt.
6. A side chat's first question (12+ characters) generates a title that replaces `Selection side chat`; a second
   question does not. A fork keeps `Fork of ...`; a subagent child gets no title call.
7. `/goal` (including a goal set on a later turn of a resumed session) and external-agent turns behave as before.
8. Editing the first message while a retry is in flight: the generated title is not written (first-query-edit rule).

### 6.5 Verification

- `core/tests/session-title-retry.test.ts` drives `executeTurn` and `maybeStartSessionTitleGeneration` with the test
  runtime and session store: attempt cap, seed choice, short first message, rename, in flight, cold resume, `/goal`,
  runtime-header deferral, side chat vs fork vs subagent gating. The first-query-edit race (scenario 8) relies on the
  existing suppression and is not covered by a new test.
- Same baselines and package checks as section 5. Not covered: manual UI run of a side chat.
