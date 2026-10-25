# ZCode CUA AX tree optimization design

Scope: data capture, cross-platform normalization, the model-visible format, stable node identity,
full/delta/no-change states, complex Web tree pruning, post-action verification, persistence and
recovery, migration and measurable acceptance. Based on real Calculator, TextEdit, System Settings and
Chrome CUA trajectories.

Core conclusion: keep ZCode's execution-safety and cross-platform contracts (`state_id`, window owner,
coordinate system, stale validation), and adopt a hierarchical semantic representation plus true
incremental patches to cut model context cost.

## 1. Measured baseline

| Scenario                | Measured ZCode CUA                                     |
| ----------------------- | ------------------------------------------------------ |
| Calculator full         | about 9,435 chars / 58 elements                        |
| Calculator small change | 9,351-11,684 chars (still dumps the full tree)         |
| TextEdit full           | 3,636 chars / 29 elements                              |
| TextEdit no-change      | still returns the full tree, about 3.6-4 KB            |
| Complex browser page    | 5,015-8,757 chars (length alone does not show quality) |

Eleven `state_id` results in one Calculator session total 112,279 chars, about 10,207 per result. Today
`changes` is only an attached summary and does not replace the full `elements`.

## 2. Model format versus current format

### 2.1 Target: hierarchical text DSL

Full (spec in §8):

```
@state s-4 mode=full app=Calculator window=main
0 window "Calculator"
  1 region "Keypad"
    6 text "Display" value="46"
    14 button "All Clear" [press]
    23 button "7" [press]
```

Delta:

```
@state s-5 base=s-4 mode=delta
~ 6 value="7"
~ 14 name="Clear"
```

Indentation keeps parent-child relations; a continuous index is the action handle; role,
selected/editable/expanded, Description, Help, ID and secondary actions are inlined on one line. Small
changes use `+`, `~` and removed ID ranges; no change returns only no-change and focus. The format is for
the model and does not carry the cross-process structured contract.

### 2.2 Current: flat JSON snapshot

```json
{
  "state_id": "s-3",
  "focused_element": 18,
  "readable_text": ["Untitled"],
  "elements": [
    {
      "index": 18,
      "kind": "textarea",
      "name": "First Text View",
      "editable": true,
      "focused": true
    }
  ],
  "changes": { "added": [], "removed": [] }
}
```

The app/window/state/coordinate-space/elements/changes/action-outcome boundaries are clear, `kind` hides
macOS AX / Windows UIA / Linux AT-SPI differences, and `state_id` + `index` guards stale snapshots. But the
flat array loses parent context, JSON keys repeat tokens, `changes` and full `elements` are returned
together, and `top_candidates` plus long natural-language guidance may follow.

## 3. Core problems

1. **`changes` is not incremental.** After an action the state is the full compact elements +
   `changes.added/removed` + duplicated `top_candidates` + static guidance, even when both counts are 0.
   The settled state returned with the action could save a `get_app_state`, but the full re-dump cancels
   the gain.
2. **Node identity and stale fingerprint are conflated.** The element fingerprint (role, title, value,
   coarse bounds) serves both diff identity and action stale/TOCTOU validation. A TextEdit textarea whose
   only change is `value` shows as removed + added; that is a state update, not a node replacement. The two
   uses must be split.
3. **Flattening drops the semantic parent chain.** Repeated "OK", "Edit", "More" controls need a parent
   (row, dialog, toolbar, section) to disambiguate; flat kind/name forces the model to guess from index,
   `top_candidates` or position hints.
4. **Complex Web trees fill the budget with containers.** A real Chrome results page: 56 of 80 elements are
   AXGroup, 75 have no effective name/value, `truncated=true`. Information-free containers fill the node
   cap first and real link/text/button nodes may be cut; the opposite extreme keeps too many duplicate
   links and long tracking URLs.
5. **Static guidance repeats in every result.** A Calculator result carries about 728 chars of leading
   guidance; a TextEdit menu-only failure trajectory totals 3,741 chars, 2,453 (66%) being policy guidance.
   That belongs in skill/tool description or structured diagnostic codes, not in every state.

## 4. Target architecture

```
macOS AX / Windows UIA / Linux AT-SPI
                  │
                  ▼
        normalized semantic tree
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
 stable node identity   material fingerprint
   full/delta align     stale/TOCTOU validation
        │                    │
        ▼                    ▼
 semantic pruning       action verification
        │
        ▼
 snapshot engine
  ├─ full
  ├─ delta
  └─ no_change
        │
        ├─ structured JSON: process/storage/replay/tests
        └─ compact DSL: model context
```

Structured JSON is the fact and recovery protocol; the DSL is the token-optimized model view. Both are
generated from the same semantic snapshot; there are not two sets of behavior logic.

## 5. State and node model

### 5.1 Snapshot identity

Only a full observation mints and exposes a new session `state_id`. delta/no_change mint no new id: the
model reuses the session `state_id` from its last full observation (implementation:
`AccessibilitySession.lastStateId()`). The broker still keeps `base_state_id` for diff internally but does
not expose that broker counter id to the model (it is an independent counter the targeting resolver cannot
resolve). A delta must declare `base_state_id`; a caller may apply a patch only when it holds the base.
Compaction, reconnection, process recovery, cross-page navigation or a lost base forces full.

### 5.2 Stable node identity

Add an opaque `node_id` to recognize the same semantic node across snapshots. Prefer the backend's stable
native identifier; otherwise combine window identity, accessible path, stable role/name and a sibling
discriminator. `node_id` never includes value, focus, selected or transient bounds.

### 5.3 Material fingerprint

The material fingerprint keeps role, title/value, enabled, bounds and necessary capability that affect
action safety, used for re-reading before actuation and stale judgment. It does not take part in delta
identity. `index` stays a short alias within the current snapshot; actions still submit `state_id` +
`index`/`node_id`.

```
{
  nodeId: "ax:window-3642:path-1.2.18",
  index: 18,
  parentNodeId: "ax:window-3642:path-1.2",
  kind: "textarea",
  name: "First Text View",
  value: "hello",
  capabilities: ["edit", "focus"],
  state: { focused: true },
  materialFingerprint: "mfp:..."
}
```

## 6. Full, delta and no-change

```json
{
  "schema_version": 3,
  "state_id": "s-5",
  "base_state_id": "s-4",
  "mode": "delta",
  "updated": [{ "node_id": "calc:display", "index": 6, "changes": { "value": "7" } }],
  "added": [],
  "removed_node_ids": [],
  "focus": null
}
```

- **full:** first observation, unavailable base, window identity change, page/document navigation, large
  node rebuild, or schema version change returns a pruned full snapshot.
- **delta:** same window/document and a changed-node ratio under the threshold returns only added,
  updated, removed, focus, selection and readable-text patches. The initial suggested threshold is a patch
  estimate under 40% of full chars; the final threshold comes from trajectory evaluation, not a hard-coded
  rule of thumb.
- **no_change:** semantic tree, focus, selection and key readable text all unchanged returns only
  `state_id`, `base_state_id`, `mode=no_change`, a repeat-observation count and at most one next-action
  sentence. Target length no more than 200-300 chars.
- **checkpoint:** a full checkpoint is sent after a fixed number of consecutive deltas, when context is
  about to compact, on a mobile replay gap, on explicit caller request, or when the server judges base
  risk raised. A delta must never depend on renderer-local state the caller cannot recover.

## 7. Semantic pruning and hierarchy

Pruning order changes from node appearance order to information value. First keep focused, editable,
pressable, selectable, selected/checked and error/status nodes; then text/link/button/menuitem with a
readable name/value; then fill the shortest parent chain for retained nodes. Pure layout containers fold
into a section/container summary by default and stay only when they disambiguate.

| Node type                     | Default                      | Exception                                              |
| ----------------------------- | ---------------------------- | ------------------------------------------------------ |
| focused/editable/actionable   | always keep                  | secure-field value must be masked                      |
| selected/checked/error/status | always keep state            | merge repeated status                                  |
| text/link/button              | keep when name/value present | merge repeated links                                   |
| group/container               | fold or omit                 | keep a summary as parent disambiguator                 |
| offscreen/invisible           | omit by default              | keep scroll targets or menus on demand                 |
| disabled                      | low priority                 | keep when the user is dealing with the disabled reason |

The budget moves from a fixed node count to a char/token budget plus semantic quotas. The response
includes `omitted_counts_by_kind`, `truncated_reason` and callable `get_element_subtree(node_id)` /
`get_more_elements(cursor)`. 56 empty AXGroups must not consume the whole budget.

## 8. Model-visible DSL

The model layer uses a stable, platform-prefix-free text DSL with the shortest parent chain; the full
JSON is still held internally. The DSL is a serializer, not a new source of truth.

```
@state s-4 mode=full app=Calculator window=main
0 window "Calculator"
  1 region "Keypad"
    6 text "Display" value="46"
    14 button "All Clear" [press]
    23 button "7" [press]
@focus none
@omitted container=4 disabled=1
```

```
@state s-5 base=s-4 mode=delta
~ 6 value="7"
~ 14 name="Clear"
@focus none
```

The DSL keeps index, kind, name/value, key state and capability; Help and native role are pulled per
subtree; `actions` are already returned unconditionally in compact and `bounds` are no longer exposed to
the model. Long URLs keep an origin/path summary with tracking queries removed; full value is requested
only when the user is working on the URL.

## 9. Action results and observation merge

Returning a settled state after an action is the right direction, but the content becomes
`action_outcome` + delta/no_change. Action execution, verification and post-observation stay in one
transaction/lock scope so token optimization does not reintroduce TOCTOU.

```json
{
  "action_outcome": { "status": "verified", "target_node_id": "calc:equals" },
  "state": {
    "state_id": "s-6",
    "base_state_id": "s-5",
    "mode": "delta",
    "updated": [{ "node_id": "calc:display", "changes": { "value": "46" } }]
  }
}
```

With `return_state=none`, only the outcome and an explicit `state_available=false` are returned. An action
with no effect returns no_change + a no_effect reason. A closed window, permission fallback or invalid base
returns a structured recovery code, not a long strategy explanation.

## 10. Browsers and large trees

In-document input, expand, select and local loading may use delta; cross-URL/document navigation defaults
to full. The basis is document identity, root signature and node reuse rate, not the app name.

Extra Web pruning rules: merge image link/title link of one card; keep only the necessary parent chain for
empty groups; strip tracking queries from URLs; split long aggregated text into per-source text nodes;
prefer viewport, focused, interactive and selected; paginate by section when over budget. For canvas / AX
sparse pages return `state_quality=visual_required` explicitly instead of faking a usable empty tree.

## 11. Screenshot and AX cooperation

Keep the AX-first default `include_screenshot=false`; capture only for visual reading, `state_image`
coordinates, AX-sparse pages or an explicit user screenshot. Images travel as media blocks/artifacts, not
inside AX JSON or logs.

When a screenshot is returned, the snapshot records window, display provenance, device pixel ratio, image
region and media ref. AX delta and image dirty crop share one `state_id`/`base_state_id`, but absence of
either must not make the other unresolvable. Desktop continuous and mobile replayable share the persisted
snapshot fact.

## 12. Cross-platform and recovery

Normalized `kind`, capability and state fields are consistent across macOS AX, Windows UIA and Linux
AT-SPI; native role, native action and backend handle exist only in adapter/private state. `node_id` may
include a backend namespace but callers treat it as opaque.

Snapshot/delta must be persistable with runtime schema validation. On a mobile replay gap, process
restart, server LRU eviction, session fork or missing `base_state_id`, request/push a full checkpoint.
Desktop continuous does not splice in the mobile-replayable-only recovery messages.

## 13. Migration plan

| Phase       | Content                                                                                                 | Compatibility                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P0 Baseline | Lock chars, tokens, success rate, node retention and latency for Calculator, TextEdit, Settings, Chrome | no output change                                              |
| P1 Identity | Introduce `node_id`; split stable identity from material fingerprint; add updated diff                  | old `state_id`+`index` keeps working                          |
| P2 Snapshot | Add `schema_version`, `base_state_id`, `mode` and full/delta/no_change                                  | capability negotiation; old clients still get full            |
| P3 Pruning  | Semantic budget, parent chain, container folding, Web de-noising, subtree/cursor                        | subtree/cursor keep a diagnostic entry                        |
| P4 DSL      | Model context switches to compact DSL; JSON for events, storage and debug                               | dual-serializer comparison period, behavior from one snapshot |
| P5 Rollout  | Gray-release delta; monitor action success, stale, reobserve, token and recovery errors                 | automatic fallback to full on base/diff anomalies             |

## 14. Code impact

- `src/zcode_cua/accessibility/models.py`: add `node_id`, `parent_node_id`, semantic state/capability.
- `accessibility/state.py`: split identity / material fingerprint; implement updated/full/delta/no-change.
- `accessibility/filtering.py`: semantic scoring, parent chain, char budget.
- `platforms/macos_ax.py`, Windows UIA, Linux AT-SPI: provide backend stable-identity candidates.
- `observation/presentation.py`: action results return delta/no-change; remove repeated guidance.
- `tools/observation_tools.py`: capability negotiation, snapshot mode, subtree/cursor tool contract.
- ZCode protocol/event/projection: persist snapshot/delta and base dependency; support replay/cold recovery.

## 15. Test plan

- **Identity:** value/focus/selected changes keep `node_id`; window/document/semantic-path changes change
  the id correctly; duplicate siblings disambiguate stably; the material fingerprint reacts to changes
  affecting action safety.
- **Diff:** updated/added/removed/no-change, duplicate nodes, focus, parent change, base mismatch,
  threshold fallback to full; a patched result equals the new full exactly.
- **Pruning:** actionable, focused and readable text never lost; empty groups do not fill the budget; the
  parent chain is shortest yet disambiguating; secure-field value is never output; long URLs lose tracking.
- **Cross-platform contract:** one fixture yields consistent kind/capability/state on AX/UIA/AT-SPI; native
  role does not leak into compact DSL; Windows DPI, macOS Retina and Linux X11 coordinate metadata keep
  existing safety semantics.
- **Trajectory E2E:** Calculator consecutive operations, TextEdit input and save panel, System Settings
  page switching, Chrome same-page interaction and cross-page navigation, AX sparse/canvas, permission
  fallback, window close, mobile replay gap, session cold restore.

## 16. Metrics and targets

| Metric                                 | Suggested target       | Note                                                       |
| -------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| Calculator warm full                   | not above 4-5 KB       | now about 9.4 KB; at most half                             |
| Native-app small-change delta          | not above 20% of full  | Calculator/TextEdit may reach 5-10%                        |
| no-change                              | not above 300 chars    | state chain and necessary diagnostics only                 |
| Complex Web full                       | per model token budget | favor semantic nodes, not mere brevity                     |
| retained semantic ratio                | keeps rising           | share of actionable/readable/stateful among retained nodes |
| base/delta recovery errors             | near 0                 | errors auto-fallback to a full checkpoint                  |
| action success / stale false positives | no worse than baseline | token savings must not cost action correctness             |
| repeat observations                    | markedly down          | no-change and action outcome should stop observation loops |

Runtime latency needs its own benchmark: startup/settle and serialization are not one metric. Split
backend capture, normalize, prune, diff, serialize, image capture and transport duration, each with its own
target.

## 17. Acceptance

1. The state schema distinguishes full, delta and no_change and carries `schema_version`.
2. delta always declares `base_state_id`; a lost base falls back to full automatically.
3. Stable `node_id` and the material fingerprint are separate.
4. A TextEdit value change is expressed as updated, not removed + added.
5. A Calculator small change no longer repeats the full 58-element tree and `top_candidates`.
6. A complex Web tree is not filled by nameless groups.
7. The model DSL keeps the necessary parent chain and the internal JSON replays completely.
8. An action result returns outcome + delta/no-change without adding observation rounds.
9. Secure fields, clipboard, secrets and sensitive values never reach the model or logs.
10. macOS, Windows, Linux and the desktop/mobile recovery chains pass tests.
11. Context cost drops markedly while action success and stale protection do not regress.

## 18. Risks and trade-offs

- **Delta depends on base.** If model context compaction or mobile replay loses the base, patches become
  unreadable. The snapshot engine must manage checkpoints, not the renderer or the prompt.
- **Stable node identity cannot be perfect for every app.** Dynamic Web/Canvas nodes without native
  identifiers can only use heuristic paths. With low identity confidence or a high tree-rebuild ratio,
  return full; never force a match to raise the delta rate.
- **Pruning can hide needed information.** Keep subtree/cursor and an omitted summary; acceptance is task
  success rate and semantic retention, not shortest chars alone.
- **Dual-format maintenance.** JSON and DSL must come from the same snapshot serializer pipeline; two
  independent filtering/diff logics are forbidden, otherwise what the model sees and the executing state
  diverge.

## 19. Trajectory and implementation references

- ZCode Calculator: `~/.zcode/cli/debug/model-io-sess_4c0dec29-abc9-45db-b92a-85b734cfa5eb.jsonl`
- ZCode TextEdit: `~/.zcode/cli/debug/model-io-sess_9ce83024-e3ca-4a27-8bb7-352186b9c06e.jsonl`
- ZCode Chrome: `~/.zcode/cli/debug/model-io-sess_d7748be0-9015-464e-b6e1-7e35b3c8563c.jsonl`
- Core implementation: `src/zcode_cua/accessibility/state.py`, `models.py`, `filtering.py`,
  `observation/presentation.py`.
