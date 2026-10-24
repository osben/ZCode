# Todo129 Implementation Boundary and Acceptance

Old-version baseline fixed at `790884b1ce`; this round's starting point `b2e2b31ea3`.

> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-129-impact-and-cases.md`

## Verified Old Conventions

- Old modelSelectionGroups / providerFamilyRuntimeModel: a Team connection uses the same family's `builtin:*-coding-plan`
  model identity and the connection key is not the model_provider; personal and team restore to the same old statistics bucket.
- legacyPersonalProviderConfigImporter writes old `builtin:zai/bigmodel` as the fixed `zai-api/bigmodel-api` instances;
  only those two exact IDs map and UUID instances are not bucketed by templateId.
- Old offPeakTelemetry is fixed `offpeak-idle-plan`; both families' new off-peak identities restore to that value.
- Event encoding is kept: send uses custom encoding, the actual request is generally provider/model, and automation and
  off-peak use the plain model ID.

## Impact

Used feature-boundary-planner; Codegraph unavailable, so the graph's telemetry / off-peak / purchase-funnel nodes, exact
reference search and old-code comparison were used. It changes display classification, home-page admission and event
construction, not fact production, sync or persistence.

```text
Registry Settings View -> plan classification -> home off-peak entry / purchase funnel
actual submission / request facts -> event field construction -> old statistics ID -> existing reporting channel
  (pure mapping, no account query or modification)
```

The pure mapping is reused by event construction (not a global transport); facts stay the real IDs. Step/Completion
mapping attributes finally (including subtasks and seeds) without changing lifecycle, usage or dedup. Web no-op, desktop
continuous and phone replayable are unchanged. Reports are captured by the test platform and never sent to the production
collector.

## Acceptance Matrix

| Group    | Must hold                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Identity | personal/Team/Start/off-peak symmetric for both families; old values unchanged; UUID/unknown not guessed; slash/colon/percent in model unchanged |
| Event    | send, request step/completion, subtask, compaction, automation and off-peak actual builder/report payloads match old values, other fields unchanged |
| Plan     | Team-only entitled=true belongs to Coding Plan; false does not count; Start independent; empty view unknown; a switch is not an unsubscription |
| Funnel   | BigModel Team is MaaS / bigmodel, Z.ai is Z_AI / z.ai; context freeze and one-shot upgrade reporting unchanged                     |
| Home     | Team-only can enter creation; grayscale off, dismiss and explicitly no Coding Plan still block; the form eligibility is not bypassed |

No real-charge purchase tests and no report or historical statistics changes. Real Electron batch verification is recorded
separately in the ledger and component tests do not stand in for whole-machine verification.
