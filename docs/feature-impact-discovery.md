# Feature Impact Discovery

## Status

- This document is the de-facto specification for how `feature-boundary-planner` runs feature scanning and impact analysis before implementation.
- It describes the analysis method and output contract; it does not change product runtime behavior.
- The feature semantic graph lives at `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`; code facts follow the current workspace and codegraph index.

## Goal

Before a developer reads large amounts of implementation or starts coding a feature change, answer:

1. Which UI entries, background flows, and run modes does the capability appear in?
2. Which entries share components, option sources, or services — and which merely share names or fields?
3. Where do each entry's draft state, defaults, validation, commit action, and final state ownership live?
4. Which neighboring features, protocol boundaries, persistence paths, recovery chains, and tests must be watched after the change?
5. Which relationships are stable product semantics, and which are only static-code reachability evidence?

The final artifact is a searchable **Impact Brief**. Expand into state cartesian products and case pruning only when product behavior must be defined or tests planned.

## Two-layer graph model

Relying only on a static call graph spreads utility functions, generic components, and test helpers into every result; maintaining hand-written documentation alone rots as the implementation evolves. Feature scanning therefore uses two evidence layers:

```text
开发者的变更意图
        |
        v
功能语义图（能力、UI 入口、状态归属、提交副作用、不变量）
        |
        v
UI Surface Matrix（逐入口追踪行为）
        |
        v
codegraph（当前调用方、实现路径、测试与图谱漂移）
        |
        v
Impact Brief（分级影响、证据、待确认项）
        |
        +----> 可选：边界矩阵、用例剪枝、E2E 交接
```

### Feature semantic graph

The graph maintains product-level relationships with at least these node types:

- `capability`: something a user or developer can describe — model selection, automation tasks, Subagent.
- `ui-surface`: an entry where the capability actually appears — conversation toolbar, automation edit page.
- `shared-ui`: components, option builders, or hooks reused across entries.
- `state-owner`: owner of drafts, runtime state, defaults, or authoritative projections.
- `service`: service boundaries for commit commands, validation, or data sources.
- `persistence`: persistence sinks — databases, config files, Markdown.
- `delivery-boundary`: desktop continuous, mobile replayable, remote workspace, etc.
- `evidence`: tests, specs, or other verifiable evidence.

Semantic edges are directed verbs, e.g.:

- `renders-in`, `shares-component`, `options-from`
- `owns-draft`, `inherits-from`, `validates-with`
- `commits-to`, `persists-to`, `projects-to`, `recovers-via`
- `covered-by`, `must-not-mutate`, `must-remain-isolated-from`

The graph keeps only high-value semantics and codegraph seeds; it does not try to replicate the full code call graph.

### How scan results settle

Every scan lists the deltas between the current graph and current code facts separately:

- For scan/explain/diagnose requests, propose a graph delta in the Impact Brief without modifying the graph.
- When entering feature planning or implementation handoff, confirm the product semantics first, then write the confirmed capability, UI surface, owner, commit sink, invariants, and code seeds back into the graph.
- One surface represents one independent user scenario and state/commit semantics; multiple component call sites inside one screen are multiple code seeds of the same surface.
- Keep node IDs stable. When product copy is renamed, prefer adding an alias to preserve historical searchability.
- Only confirmed product relationships enter the graph; purely static reachability, test dependencies, and unexplained new callers stay as drift/evidence.

Later developers can then search confirmed feature relationships and, via codegraph, discover where the graph lags the implementation.

### codegraph code facts

codegraph verifies the current implementation; it does not replace product semantics:

- Start from the symbol/file seeds declared in the semantic graph.
- Find direct callers of shared components, builders, hooks, stores, and service methods.
- For each UI entry, trace "local state → defaults/inheritance → validation → commit action → authoritative state or persistence".
- Expand 2 levels by default; go to 3 only when a key ownership is still unclear.
- `affected tests` are evidence only — they do not prove product feature dependency.
- Current callers disagreeing with the semantic graph are recorded as `graph-drift-candidate`; a human confirms before the graph updates.

Prefer codegraph for indexed code; use `rg` for docs, configs, generated files, or anything not yet indexed.

## Classify the change layer first

The same "feature change" has entirely different impact surfaces at different layers. Classify before scanning:

| Layer           | Typical questions                          | Default focus                                                       |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `presentation`  | copy, layout, visibility, controls          | every entry reusing the UI, theme, responsiveness, i18n              |
| `option-source` | candidate sources, grouping, sorting, filters | shared builders, provider registry, per-entry secondary filtering |
| `draft-default` | initial values, inheritance, fallback       | each entry's draft owner, workspace/session defaults                 |
| `validation`    | availability, permissions, blocking conditions | per-entry gating, pre-commit validation, error presentation      |
| `commit-effect`| what actually changes on click              | commands/services, runtime owner, isolation invariants              |
| `persistence`   | save location, load and migration           | repo/config/Markdown, cross-window/cross-workspace isolation        |
| `recovery`      | reconnect, snapshot, queue, recovery        | desktop continuous vs web remote replayable boundaries              |

If the user did not state the layer, do the cheap scan first, then ask only about ambiguities that would change the conclusion.

## UI Surface Matrix

Whenever a capability appears in multiple surfaces, record these fields per entry:

| Field                | Question to answer                                            |
| -------------------- | -------------------------------------------------------------- |
| User scenario        | Why does the user invoke the capability here?                  |
| UI entry             | Which page, panel, dialog, or toolbar?                         |
| Shared implementation| Which component, option builder, hook, or service is reused?   |
| Display/draft state  | Who displays the current value; who holds the local edit?      |
| Default/inheritance  | Where does it resolve when not explicitly configured?          |
| Validation/gating    | What hides, disables, falls back, or errors?                   |
| Commit action        | Which command/service is finally invoked?                      |
| Authority/sink       | Where do runtime state or persistence finally land?            |
| Mode boundary        | Do desktop/web/mobile, local/remote differ?                    |
| Isolation invariants | What must this entry never change accidentally?                |

"Shared component" does not mean "shared behavior". Same-named `model` fields are not the same state: the conversation model may change the current session, the automation model saves into the automation record, and the Subagent model saves into agent Markdown.

## Impact ranking

Relationships in the Impact Brief rank as:

1. `must-inspect`: shared modification points or the same authoritative state/commit path; missing one likely regresses directly.
2. `should-inspect`: shared candidate sources, validation, defaults, or product invariants — usually needs regression confirmation.
3. `conditional`: relevant only under specific run modes, workspace types, or change layers.
4. `invariant-only`: no code change needed, but proof is required that it did not change accidentally.
5. `evidence-only`: tests or statically reachable nodes — verification only, never claimed as product dependency.

Every conclusion carries a relationship type, a reason, and at least one code/doc evidence. Never flatten all codegraph-reachable nodes into "affected features".

## Model selection example

Model selection is a typical cross-UI capability:

```text
                         +-> 对话工具栏 -> session/draft runtime
模型候选与选择控件 ------+-> 自动化编辑 -> automation record
                         +-> 用户 Subagent -> agent Markdown
                         +-> 内置 Subagent -> built-in override
```

Scanning this capability must at least verify:

- Current callers of `ModelConfigSelect` and `buildModelSelectGroups`.
- Whether all entries use the same provider registry and whether per-entry filtering exists.
- That the draft owners and commit sinks of conversation, automation, and Subagent remain separate.
- That opening or canceling the automation editor cannot change the workspace/session model.
- That changing shared candidate-generation logic does not wrongly unify per-entry default/inheritance semantics.
- That a new caller without a matching UI surface in the semantic graph is reported as graph drift.

## Handoff to boundary planning

Impact discovery answers "what else must be inspected"; boundary planning answers "what product behavior each state combination should have". They connect in this order:

1. Produce the Impact Brief and UI Surface Matrix.
2. Turn undefined or conflicting relationships into boundary questions and confirm with the user.
3. Write the confirmed capability, surface, owner, commit sink, and invariants back into the feature semantic graph.
4. Enumerate state combinations only for the confirmed scope.
5. Mark combinations `accepted`, `undefined`, `pruned`, `ignored`, or `bug-candidate`.
6. Update the corresponding spec, case catalog, and coverage matrix before implementation or E2E writing.

If the user only asked to scan, explain, or diagnose, stop at the Impact Brief — no product code or existing spec changes.

## Output contract

Every feature scan outputs at least:

- Feature and change-layer summary.
- UI Surface Matrix.
- Shared implementations and divergent behaviors.
- Ranked upstream/downstream feature relationships.
- State owners, validation points, commit sinks, and persistence targets.
- Invariants that must hold.
- codegraph seeds, direct callers, expansion depth, and related test evidence.
- `graph-drift-candidate`.
- Open questions that would change implementation or test scope.

For continued boundary planning, append state dimensions, pruning decisions, formal-proof cases, and E2E handoff material.
