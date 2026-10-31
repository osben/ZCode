# Blocked-runtime slash menu E2E coverage (BSM)

Rule: while the session runtime is blocked, the composer slash menu lists only the recovery command (`/reload`), and only while recovery is available; ordinary app commands such as `/plan` are hidden (`selectComposerAppSlashCommands`, `specs/upstream-3.17.1-sync-catalog.md` §7).

Spec: `packages/desktop/test/e2e/conversation-session/conversation-session-blocked-runtime-slash-menu.test.ts`. It sends no model requests; its case manifest declares `providerRequestPolicy: "none"`.

| ID    | Scenario                                                                        | Assertion                                                                         |
| ----- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| BSM01 | Cold-open a persisted session while the resume hook holds (`initializing`)      | `/` lists exactly one app command, `app-slash:reload`; `app-slash:plan` is absent |
| BSM02 | Release the hook; the runtime turns ready                                       | `app-slash:plan` is back in the menu (control for BSM01)                          |
| BSM03 | Corrupt `session.revert` while the hook holds; materialization fails (`failed`) | The initialization retry shows; app commands are exactly `app-slash:reload`       |

## How the runtime is blocked

No product hook. The spec reuses the history-first seed of HF01/HF02 (`conversation-session-history-first.test.ts`, `test/e2e/helpers/session-history-first-fixture.ts`):

- The seed writes a `SessionStart` process hook with matcher `resume` into the CLI config. Cold-opening a persisted session runs it, and the hook waits for a `release` file. Until then `runtimeInitialization.status` is `initializing`, so the composer is blocked while history and the editor are visible.
- For `failed`, the spec writes `'{'` into the session's `revert` column in the CLI DB while the hook holds, then releases it. The real final materialization read fails (same fault as HF02).

## Not covered by E2E

- Lifecycle `faulted`. It only results from a failed runtime release (`session-lifecycle/controller.ts`). Killing the CLI process does not produce it: the Host respawns the CLI transparently (`conversation-session-shared-cli.test.ts`). And when `faulted` does occur, the conversation store goes to `status: "error"`, so `SessionPane` renders `SessionSubscriptionErrorPanel` instead of the composer; the slash menu is unreachable in that state.
- Recovery unavailable → no app command. That needs `remoteAvailable = false` (a remote workspace that dropped). Covered only by the component test `packages/ui/test/v4ConversationComposerBlockedSlashMenu.test.ts`.
- CLI slash commands (`/goal`, `/compact`, …) do not go through this selector and stay listed while blocked; the spec does not assert them.

## Runs

macOS Electron, built from this branch:

- Green, 2/2 each: `desktop-e2e-20261031051923940-p20879-fb044b6fc27af613`, `desktop-e2e-20261031052506223-p30825-f5494f7fbfbbe62b`, `desktop-e2e-20261031052554254-p33104-da81d38bdd7bb2c8`, `desktop-e2e-20261031052641673-p34632-b7f60e7751da8194`; with the case manifest in place, `desktop-e2e-20261031052805042-p37042-952c45e777aefdb7`; at the final commit, in one invocation with `history-first`, `desktop-e2e-20261031054058409-p53532-ef460f4bcf18578b`.
- Red control: with the selector temporarily set back to the old "blocked hides every app command" rule, `desktop-e2e-20261031052350487-p27427-67be739a21761be4` fails BSM01 and BSM03 on their own `/reload` anchors.

Not run: Windows, Linux, mobile replayable, Docker. The spec lives in the formal `conversation-session/` directory, so it runs wherever that directory runs. It is not in the Docker verified suite (`CONVERSATION_SESSION_VERIFIED_E2E_SPEC`), because admission needs a verified Docker run artifact and none was produced.

## Seed fix

`provider-readiness-history-fixture.ts` ran the CLI app-server with `input: ""`, closing stdin at once. Inside the wdio worker the CLI got only as far as `startup/storageState` `checking` before exiting with "Protocol input closed", so `db.sqlite` never existed and every history seed failed in `beforeSession` (HF01/HF02 too: `desktop-e2e-20261031051420309-p16027-99ac9aff8ba1ab7a`). The seed now keeps stdin open until the session DB reports `phase: "ready"`.

Other specs that use this seed, run on macOS against the same build:

| Spec                                      | Original seed (fails in `beforeSession`)                | Fixed seed (seed passes, later failure)                                                                           |
| ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| HF01/HF02 `history-first`                 | `desktop-e2e-20261031051420309-p16027-99ac9aff8ba1ab7a` | HF01 passes; HF02 fails "retry re-runs the resume hook" (`desktop-e2e-20261031052032419-p22831-cb9ffbcdc1f9706d`) |
| `provider-readiness-agent-startup`        | `desktop-e2e-20261031053325860-p45048-988aac779e5ac37d` | sidebar has no dormant-workspace project (`desktop-e2e-20261031053213090-p43433-b65b3b9628c31d20`)                |
| `conversation-session-task-title-marquee` | `desktop-e2e-20261031053838021-p49625-5250dfb9be268e5e` | sidebar shows no project (`desktop-e2e-20261031053417883-p46312-58bf358081876e3e`)                                |
| `usage-stats-app-usage`                   | `desktop-e2e-20261031053916975-p50806-d0b168702f87644d` | usage totals and empty state missing (`desktop-e2e-20261031053528980-p47725-1920811dda79dff3`)                    |

These later failures were hidden behind the seed failure, so this change does not cause them. Their root causes have not been investigated.
