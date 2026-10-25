# 3.12.2 Chat Config Wait Isolation

Baseline: `origin/hotfix/3.12.2`, `5f7d77dac3`. This record describes only this fix; the field results
below are from 2026-09-14 on macOS arm64.

## Feature summary

- Intent / capability: chat creation and cold resume do not depend on optional remote configuration;
  the OffPeak tools are admitted at actual call time.
- Layer / mode: validation, recovery, runtime defaults; implementation-handoff.
- Primary seeds: `createZCodeAgentService`, `getModelContextBudgetStrategy`, `AgentRuntime`,
  `getAutoCompactThreshold`.
- Not included: duplicate draft creation, MCP startup, the config network failure itself, page gray
  release, quota/billing algorithms.

## UI surface matrix

| Scenario / UI               | Local state / command              | Shared owner                         | Behavior / boundary                                                            |
| --------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Cold draft / Composer       | Renderer draft → V4 createSession  | Host capability → CLI Runtime        | tools registered locally; a pending config does not block sending              |
| Existing session / Composer | sendText                           | same CLI Runtime                     | no new budget read; FIFO unchanged                                             |
| Sidebar cold resume         | subscribe → resumePersistedSession | workspace capability → createRecord  | keeps the original workspace policy channel, restores history and tools        |
| Idle create tool            | approval → OffPeakCreate           | Host handler → OffPeakTaskService    | gray release / plan / model validated at call time, then take number / persist |
| Idle query tool             | OffPeakList                        | Host local task repo                 | workspaceKey isolated; no new remote query                                     |
| Mobile / remote workspace   | trusted attachment → preferences   | existing shared-host/remote bridge   | same fixed budget; remote still registers no idle tools                        |
| Idle page                   | original store / form              | original subscription + task service | page gray release and admission rules unchanged                                |

## Shared and divergent behavior

Both Host resolvers directly return the same shared budget constant; the CLI normalizes legacy input at
the Runtime and protocol materialization boundaries. Tool registration only says this machine can accept
the call; create admission says whether the account can take a number right now. Page visibility is
independent and is not opened up by registration.

## Relationships / owners / invariants

- workspace sync and legacy/V4 creation -> tool registration: a Host local capability; policy tests and
  SCB01/02.
- OffPeakCreate -> validation -> createTask: Host handler; SCB03 rejection means createTask=0, the
  existing allowed path is unchanged.
- Runtime budget -> compact / per-step output cap / sub-Agent: unified Core preflight; SCB04 / OTB /
  subagent unit tests.
- Invariant only: trusted clientMode, workspaceIdentity, owner/FIFO stay with the original
  attachment/CLI authority; no queue or Host is created.
- Invariant only: client-config success cache / forced refresh / other consumers stay with the original
  provider owner; no cache, timer or background refresh was added.

No database/Settings persistence is added; the compatible protocol still accepts legacy input, and the
new Runtime does not adopt the old algorithm.

## Graph / planning handoff

No `.codegraph` existed in the new worktree and by convention none was built; depth-2 paths Host ->
config / CLI -> Runtime -> compact, output cap were checked by exact function/call-site search; no
codegraph scan is claimed. The capability graph lacked the constraint that chat startup must not wait on
these two configs; the user-confirmed invariant was added to the conversation-runtime and
off-peak-model-execution nodes. Other nodes/edges and persistence are unchanged.

User final confirmation: local tools are always registered and the gray release is checked only at
actual creation; the budget is fixed at preflight-v1 and the remote fallback is dropped. SCB01-05
setup/action/assertion and evidence layers were written into the case catalog and coverage matrix
first. Network-latency parameters are not fully permuted: the pending barrier represents the worst
wait; config rejection is represented by Host unit tests; hot upgrade of an old process is pruned. No
open product item. The new E2E stays in manual-review/pending and is not marked as manually reviewed or
Docker-admitted.

## Validation

### Run chain and timing

```text
Enter -> Host local capability + fixed budget -> CLI admission -> page binding/user message -> provider HTTP
               client/configs stays pending and takes no part in the waits above
OffPeakCreate -> existing approval -> Host gray release/plan/model -> createTask -> take number/persist
```

Same isolated config gateway and fixture; the baseline temporarily restored the baseline production
source and rebuilt the tests, then restored all fixes. Single samples in milliseconds, not online
percentiles. The HTTP point is the time the local provider proxy received the request; the admission
point is the CLI `v4 prompt admitted` log; page binding and user message visibility are recorded by a
DOM observer.

| Scenario                             | CLI admission | Page binding | User message visible | HTTP request |
| ------------------------------------ | ------------: | -----------: | -------------------: | -----------: |
| baseline cold draft                  |         39444 |        39486 |                40081 |        40091 |
| fixed cold draft                     |           591 |          613 |                 1259 |         3373 |
| fixed existing-session follow-up     |            16 |            0 |                  115 |           36 |
| fixed send after restart cold resume |            45 |            0 |                  113 |         1476 |

Page binding 0 in follow-up/resume rows means the session was already open before Enter. The baseline
had 8 config requests and 0 responses and finally failed because the tool list lacked OffPeakCreate;
the three fixed stages had 6/6/10 requests and always 0 responses. Raw evidence is in the workspace
`packages/desktop/.e2e-artifacts/scb-baseline/` and `scb-final/`, each `timing-reviewed.json` keeping
the associated session id and raw timestamps and runtime-logs keeping the admission logs.

The new case additionally requires Enter-to-HTTP below the existing 15-second single config timeout, so
"finally succeeds after waiting out the timeout" cannot pass. The independent rerun `scb-guard-isolated/`
passed with cold/follow-up/resume HTTP at 2743/87/2118 ms and the config still unanswered.

### Automated results

- Targeted service/Host 4 files 91 items, Core 6 files 59 items, session protocol 2 files 90 items pass.
- shared-host attachment, remote workspace bridge, connection scope 3 files 38 items pass.
- Idle tool bridge, real temporary database / mock gateway integration, task service 3 files 29 items
  pass.
- Desktop real Electron E2E: config-wait isolation, model-output-token-budget and
  model-output-token-preflight specs pass; the Compact 94K threshold, 21K reserve, summary 20K and
  per-request cap all go through the real Runtime/HTTP.
- root `pnpm typecheck`, Desktop `typecheck:e2e`, Core typecheck pass; root lint 0 errors, separate lint
  of Core/bootstrap/contracts 0 errors; architecture check 0 new issues.
- `ZCODE_AFFECTED_TEST_BASE=origin/hotfix/3.12.2 pnpm verify:pre-push` passes, running lint,
  architecture, changed unit tests and related unit tests on the real diff from baseline `5f7d77dac3`
  to the implementation commit (not the skipped result under an uncommitted diff). Only this record and
  the D49 doc formatting were added afterwards; production code and tests did not change.
- The fixture metadata check passes. The new case stays manual-review/pending, claiming no manual
  review or Docker admission.

### Not passed and boundaries

- Bootstrap protocol tests 109/111 pass; two fail and reproduce on the baseline: the remote Cron
  denylist and the array/object contract of Account Config providers. Not changed in passing.
- The global conversation coverage audit has 9 errors identical to the baseline: I74/I75 references,
  four statistics, three stale generated docs. The graph YAML parses with no duplicate ids; four
  dangling edges are identical to the baseline, and this change only added the invariants of two nodes.
- The extra `conversation-session-offpeak-create` E2E failed in beforeSession because the existing mock
  config code reads providers as an object while the existing shape is an array, reporting a missing
  `account:zai-offpeak-idle-plan.api`; it never reached the test body and is not counted as passed. The
  normal take-number/persist path is verified by service integration tests.
- One extra config E2E captured a Host `runtime is not running` during a model switch with no user
  message submitted; logs are in `scb-final-guard/`. The model-switch / duplicate-draft race is not
  handled here; the independent rerun passed, and that failure is not explained as a config wait nor is
  the race claimed fixed by the rerun.
- The mobile chain was verified to the shared-host/remote bridge protocol and service layers; no real
  mobile device, no complete SSH/WSL/Docker GUI, no Windows/Linux Desktop run. continuous/replayable,
  owner and identity code are unchanged.
- The CLI top-level lint wrapper lacks a usable turbo config; the per-package lint above is the actual
  executed result.
- The config network / MCP startup root cause is untouched and no cache or background refresh was
  added; running processes before upgrade still use their own algorithm.
