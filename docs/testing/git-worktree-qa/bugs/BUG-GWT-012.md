# BUG-GWT-012: raw ICU plural template in the branch-switch guard dialog

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)
- Severity: S4 (cosmetic/text; guard semantics intact: task list and cancel work)
- Cases: B6
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixture R1 (basic): repo with commits on `main` (QA-PROMPT §4).
2. QA app: open project `basic`, start a live session whose message yields a running task for 10+ s (for example "Run these six commands…" with 5-6 separate bash calls).
3. About 3 s after the task starts: status panel -> branch switcher -> pick `release`.
4. The guard dialog "Switch branch?" appears; read the description under the title.
5. Minimal mechanism check (what the renderer does):

```ts
import { createIntl } from "@/i18n/createIntl.js";
import enUS from "@/i18n/locales/en-US.js";
// -> "...for {count, plural, one {# running task} other {# running tasks}}:" - the plural is not rendered
createIntl("en-US", { "en-US": enUS }).formatMessage(
  { id: "branchSwitchGuard.description" },
  { count: 1, branch: "release" },
);
```

## Expected

`specs/composer-branch-switcher-semantics.md` §2: the guard is a confirm dialog listing the affected active tasks with meaningful count text ("Switching the branch changes the working tree for N running task(s): ..."); the number and word must be rendered, not output as a template.

## Actual

- The dialog description shows the raw ICU template: "Switching to release changes the working tree for {count, plural, one {# running task} other {# running tasks}}:". `{branch}` is substituted; `{count, plural, …}` is NOT rendered in any locale.
- 2/2 reproductions in case B6 (dialog with a running task of a checkout session).
- Git before/after: `main`, unchanged (switch cancelled via Cancel; the guard works). No log errors.

## Cause (confirmed on all layers)

- `packages/ui/src/v4/composer/branchSwitchGuard.tsx:144-150`: the description is formatted via `intl.formatMessage({ id: "branchSwitchGuard.description" }, { count, branch })`.
- `packages/ui/src/i18n/createIntl.ts:28-37,60-62`: after lookup, `formatMessage` only does naive `replaceAll("{key}", value)`. ICU syntax `{count, plural, one {…} other {…}}` is not parsed; the template has no literal `{count}` token, so the whole fragment stays in the output while `{branch}` is substituted.
- `en-US.ts:5193-5194` (also `zh-CN.ts:4887`, `uk-UA.ts:4884`): the message has an inline ICU plural, but the project's intl layer supports plurals only through `formatPlural` (`createIntl.ts:63-74`), which expects separate catalog keys `id.one`/`id.few`/`id.many`/`id.other` (convention of all other plural messages, for example `sessionManager.count.sessions`, `chat.codeComments`).

## Fix direction

UI/i18n only, no new dependencies: follow the project convention. Split into a simple prefix with `{branch}` (`formatMessage`, for example `branchSwitchGuard.descriptionPrefix` = "Switching to {branch} changes the working tree for") plus a plural family for the count (`formatPlural` with keys `branchSwitchGuard.taskCount.one/.few/.many/.other` = "{count} running task(s)") in all three catalogs, assembled in `branchSwitchGuard.tsx` (134-158).

## Test

`packages/ui/test/branchSwitchGuardI18n.test.ts`, unit (jsdom + @testing-library/react; real `ZCodeIntlProvider` and the en-US catalog so the production formatting path is exercised; only the task-list hook, toast and dialog primitives are mocked; no sleeps). Name: `BUG-GWT-012: guard dialog renders the localized plural instead of the raw ICU template`. It opens the guard with one running task (count = 1, branch = "release") and asserts the text contains `release`, does not contain `{count, plural`, and contains "1 running task". Was `it.fails`; marker removed after the fix.
