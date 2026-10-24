# Git Commit Dialog E2E Coverage

Updated: 2026-07-07

## Feature summary

The top Git write operation converges into a single "commit or push" entry, and the commit dialog is a compact, keyboard-first manual commit flow: generating a commit message only fills the input; commit / commit and push / push are triggered manually by the user in the bottom Command action area.

## UI operation inventory

| ID | UI operation | Expected behavior | Evidence layer |
| --- | --- | --- | --- |
| GCD01 | Click the top Git "commit or push" main button | A dirty repo opens the commit dialog; no three-dot dropdown to the right of the button | DOM / dialog |
| GCD02 | Open the commit dialog | Standard overlay; compact `max-w-md` width; current branch and `+/-` stats at the top | DOM / layout |
| GCD03 | Dialog content finished loading | The commit message input is auto-focused | activeElement |
| GCD04 | Click the current branch at the top | Expands a switchable branch list; the commit dialog shows no branch footer action | DOM / branch list |
| GCD05 | Type a commit message manually | The input keeps focus and content | DOM value |
| GCD06 | Click the bottom-right Sparkles generate button | Only generates and fills the commit message; does not commit automatically | service / DOM value |
| GCD07 | Toggle "include unstaged changes" | shadcn-style checkbox; the toggle affects the file count and later stage/commit scope | DOM / service payload |
| GCD08 | ArrowDown / ArrowUp with the message input focused | The selected Command action switches among "commit / commit and push / push" | DOM selected state |
| GCD09 | ArrowDown / ArrowUp with the bottom Command focused | Same switching; no check mark, only the selected item's shortcut badge | DOM selected state |
| GCD10 | Primary shortcut + Enter | Command+Enter on macOS, Ctrl+Enter on Windows/Linux, triggers the selected action | keyboard / service call |
| GCD11 | Select "commit" | Must be committed manually; only if the input is empty is a Conventional Commit message generated first, then committed | service call / git state |
| GCD12 | Select "commit and push" | After a successful commit, push the current branch immediately | service call / git state |
| GCD13 | Click the main button on a clean, ahead repo | The main button becomes the push path and opens the push dialog | DOM / service call |

## Pruning decisions

| Candidate | Decision | Reason |
| --- | --- | --- |
| GCD01/GCD02/GCD03/GCD04/GCD05/GCD07/GCD08/GCD09 | accepted | Pure UI / local Git state can be built stably, no provider request or remote needed |
| GCD06 | planned | Needs case-local provider replay or manual capture; must not mix into the pure UI case |
| GCD10 | planned | Must verify platform shortcut mapping and action trigger; suited to a separate no-push commit service assertion |
| GCD11 | planned | Changes Git history; build a disposable repo and assert commit message / staged paths |
| GCD12/GCD13 | planned | Needs a remote/upstream fixture; must not mix with the basic commit dialog UI |

## E2E case plan

| Case | Path | Status | Setup | Action | Assert |
| --- | --- | --- | --- | --- | --- |
| GCD-UI-01 | `packages/desktop/test/e2e/git/git-commit-dialog-ui-flow.test.ts` | formal | Before WDIO starts, the default workspace is initialized as a Git repo with staged, unstaged and a second local branch | Open the commit dialog, type a message, toggle the checkbox, switch Command with arrow keys, expand the branch list | Dialog overlay exists, input auto-focused, button / checkbox / Command / branch list states as expected |
| GCD-GEN-01 | TBD | planned | case-local provider replay + dirty repo | Click Sparkles generate | The input is filled with a Conventional Commit message, no commit triggered |
| GCD-COMMIT-01 | TBD | planned | disposable repo + no remote | Type a message manually, Cmd/Ctrl+Enter triggers "commit" | A new commit in Git history; only current-scope files staged |
| GCD-PUSH-01 | TBD | planned | disposable bare remote + ahead branch | Click the main button on a clean ahead repo | The push dialog opens and push / set-upstream runs |

## Handoff notes

- The `e2e:promote` dry-run confirmed the script supports only `conversation-session`; the Git domain was moved manually to the formal case root under the same promotion rule. The promote tool can be extended to the `git` domain later.
- `e2e:fixture:check` currently supports only the `conversation-session` formal directory; `GCD-UI-01` has no provider fixture dependency, so formal verification is the WDIO single spec.
- The stable contract of `GCD-UI-01` is `providerRequestPolicy=none`: it does not click generate, commit or push.
- Later generate / commit / push cases must be split into case-local fixtures so model requests, Git history side effects and remote push do not contaminate each other.

## Dialog radius migration (2026-09-04)

Per the [dialog radius rule in DESIGN.md](../../DESIGN.md#dialogs), ordinary Dialog shells use `2xl` uniformly and business `xl` / `3xl` overrides are cleaned; the chat attachment preview, feedback screenshot preview and CUA screenshot preview explicitly keep `xl`. Dialog internal containers and controls are not changed.

GCD-UI-01 asserts the commit dialog's computed radius is 16px. The shared default, business overrides and the three preview exceptions are covered by unit tests. Desktop and mobile Web reuse the same component with no process, state-sync or recovery semantics change; cross-platform and mobile independent visual verification must be recorded separately.

Verification: the new radius test failed before the change and the related unit tests pass after it (first run 34, then 18 in that test group after adding the chat-area lookup branch). `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e` and `pnpm lint` pass (41 pre-existing warnings, 0 errors). macOS Electron GCD-UI-01 1/1 passes including the 16px computed-radius assertion (run ID `desktop-e2e-20260904080854303-p50838-b01f152a8e3d50f0`). The entries that keep `xl` for the three previews are verified by unit tests; the preview UIs were not run one by one, and mobile Web, Windows and Linux have no independent visual verification yet.
