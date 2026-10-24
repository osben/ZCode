# Conversation Session Goal Manual Review E2E

## Background

A set of human-judged E2E cases for a special period. The goal is not to fix product expectations as strict assertions immediately, but to run the goal-related paths automatically first and generate screenshots, UI state, queue state, compact markers, tool-call blocks and DeepSeek captures, so a human can review whether the behavior meets expectations.

These cases cannot replace formal regression tests. After human confirmation, the stable paths must be settled into ordinary E2E with UI, protocol, log, file and network-layer assertions added.

## How to run

The default full desktop E2E does not run manual review specs. Turn it on explicitly:

```bash
ZCODE_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_API_KEY=<real-provider-key> \
pnpm exec wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/conversation-session-goal-run-cases.test.ts
```

Manual review mode forces the real DeepSeek v4 flash capture chain and does not use replay fixtures. Output goes to:

```text
packages/desktop/.e2e-artifacts/<run-id>/manual-review/goal-run-cases/
```

Each case generates:

- `steps.ndjson`: a structured record of every step.
- `summary.md`: the human review summary.
- `*.png`: screenshots of key steps.
- The top-level DeepSeek capture file: the network capture that `E2E_PROVIDER_CAPTURE_PATH` points at.

The capture proxy puts the CA and capture file in `packages/desktop/.e2e-network-capture/` by default. This directory must not be placed inside `.e2e-home`, because WDIO clears `.e2e-home` before each session starts to keep tests isolated; if the CA is deleted by the reset, the agent child process reading `httpProxyCaCertPath` fails directly with `ENOENT`.

Capture mode only needs to capture real DeepSeek provider requests. The default `NO_PROXY` bypasses `localhost`, `js.stripe.com`, `zcode.z.ai` and `cdn.zcode-ai.com`, so telemetry/CDN requests at app startup do not enter the MITM proxy and raise unrelated certificate warnings.

## Preset startup state

Manual review cases should not spend time on repeated login and model setup. WDIO `beforeSession` resets `.e2e-home` and then presets directly:

- `setting.json`: writes `providerFamilyDomain=zai`, `providerFamilyDomainMigrated=true` and `modelProviderFamilyModes.zai=apiKey`, so the welcome page does not ask for login again.
- `credentials.json`: writes an e2e-only placeholder token, used only to pass the local startup guard.
- `model-providers.json` and the CLI `config.json`: write `e2e-upstream/deepseek-v4-flash`.
- In capture mode `httpProxy` and `httpProxyCaCertPath`: injected into the agent child process via the settings-page proxy semantics, so real DeepSeek requests enter the capture proxy.

`prepareConversationE2E()` first tries to enter the default workspace directly; only when the preset is missing does it fall back to UI API Key login. When the DeepSeek helper detects that the preset provider is already usable it also skips the settings page and corrects the UI once only if the toolbar's current model differs.

## Read-only tool call requirement

The goal prompt must require the agent to use read-only tools so that it does not return plain text only. The current manual review prompt requires trying at least:

- `Glob`: find project files.
- `Grep`: search for goal / conversation-session related content.
- `Read`: read matched files.

The prompt also explicitly forbids side-effect operations such as `Edit`, `Write`, delete, move, install and commit. The test does not hard-code "the tool-call content is fully correct" as an assertion, but records the tool call blocks that appear in the UI for human judgement.

## Currently covered run paths

- completed + no goal + `/goal`
- completed + existing goal + `/goal`
- running + no goal + `/goal`
- running + existing goal + `/goal`
- goal running + stop
- interrupted held queue + `/goal`
- goal edit, delete, reorder in a held queue
- manual compacting + `/goal`
- auto compact before queued goal
- session switch + goal

The manual compact scenario only requires observable marker / streaming / queue evidence after the `/compact` operation and does not assert that compaction must succeed in the manual review phase. With real DeepSeek and a tiny context window manual compact may interleave with auto compact, and the marker may be `started`, `failed` or taken over by auto compact; these are left to human review first.

## Prompts to reproduce by hand

These prompts are kept as manual reproduction inputs. They do not enter the automated verification statistics and do not mean a WDIO assertion exists. After the observation points and product expectation are confirmed, decide whether to convert them to stable E2E.

### MR-GOAL-PROMPT-01 Restoring the timeline after a long goal auto-continues

Goal: reproduce the scenario where, after a goal auto-continues for several rounds, the UI backfills the historical `goalVerificationTimeline` in one go upon foreground restore/refresh, which visually looks like several verifiers stacked together.

Input:

```text
/goal 帮我写一个10万字论文，解释AI存在的意义，直接开始输出，不用写到文件里
```

(The prompt reads, in English: "write me a 100,000-character paper explaining the meaning of AI's existence, start outputting directly, do not write to a file".)

Manual steps:

1. Create a local desktop task.
2. Send the `/goal` prompt above.
3. Wait until it passes round 2 or 3; do not stop.
4. When an assistant body has just finished and it is near the verifier, switch the UI away: to another task, to another workspace, or close the window and reopen it.
5. Wait about 60 seconds so that the background keeps completing a few rounds of `turn -> verifier -> continuation`.
6. Return to the original task and observe whether the goal verifier timeline shows rounds, order and time relations clearly.

Optional log observation:

```bash
tail -f ~/.zcode/cli/log/zcode-$(date +%F).jsonl | rg "target\\.continuation|target\\.completion_verification|turn\\.started|turn\\.completed"
```

Observation points:

- Whether the CLI layer is still the serial `turn -> verifier -> continuation` and not several verifiers starting concurrently.
- Whether the verifier returns `passed:false` and continues to the next round, which is normal behavior of the current goal logic.
- After foreground restore, whether the UI backfills historical synthetic dividers into the message stream in a batch.
- Whether the iteration in the timeline text is repeated, skipped or out of order, e.g. two identical `Iteration 6`.
- If it looks visually like "the verifications are all pushed together", distinguish whether the runtime was really concurrent or it is a restore-display problem when merging snapshot/live.

## Notes

- These cases really access DeepSeek; upstream rate limits, balance, network and certificates all affect the result.
- Screenshots are human evidence only and not the basis of automatic judgement.
- To ease review the cases actively stop some long-running goals, to keep real model calls from running away.
