# Desktop QA kit

Agent-driven QA of the dev desktop app (Electron over CDP with `agent-browser`), with live log watching, parallel fixers and an issue ledger that a second agent can re-verify.

| File                                | Purpose                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-qa-orchestrator-prompt.md` | Prompt for the orchestrator session: preconditions, launch, parallel lanes (UI driver, log watcher, fixers, reviewer), fix packs |
| `scenarios.md`                      | Scenario catalog with stable IDs (`SB-`, `CP-`, `CH-`, `SP-`, `ST-`, `MS-`, `MI-`), tiers P0–P2, selectors and expected results  |
| `issue-ledger.md`                   | Issue ledger: template, statuses, pre-loaded known items; numbering continues from ISSUE-025                                     |
| `desktop-qa-verifier-prompt.md`     | Prompt for an independent verifier that re-runs the `Verify` steps of given issues and confirms or reopens them                  |

Usage:

1. Full run: start a new Claude Code session in this repository and paste the part of `desktop-qa-orchestrator-prompt.md` below the line.
2. Re-check fixes: start another session and paste `desktop-qa-verifier-prompt.md` with the issue IDs and the target branch or PR.
3. Keep `scenarios.md` current: when a run finds a wrong selector or a new flow, fix the catalog in the same PR as the ledger update.

History: earlier rounds are in `docs/plans/2026-10-21-qa-findings.md` and `docs/plans/2026-10-2*-app-qa-*-plan.md`.
