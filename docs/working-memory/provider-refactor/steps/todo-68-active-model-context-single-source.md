# Todo 68: Active Model as the Single Source for Execution Context

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation and verification done (2026-09-03).
>
> Source: after switching to a same-named model on a real device, the model only perceived the new Provider on the next turn.

## 1. Problem and root cause

The formal request already used the Active Model created from this turn's `ModelSelection`, but the Context prefix still derived `currentModel` and model-dependent tool hints from the Session Selection. The two chains applied at different times:

```text
this turn's Submission Selection
      +--> Active Model -> formal request
      `-- not yet written to Session Selection
old Session Selection -> Context prefix -> model sees "Current model"
```

A Turn applied the Submission Selection only after async Context initialization and the SessionStart Hook; by then `activeTurn` existed and the old refresh guard forbade rewriting the current Turn's Context. The Adapter request used the new Model while the in-request environment text named the previous Model (switching always lagged one turn).

The same split also affected Guide switching Model at a legal model-step boundary, execution-scoped Off-Peak Models (not changing Session Selection), Subagent inheriting the parent Active Model while building child Selection from the parent Session Selection, and Context tool hints not using the Model held by the formal request.

## 2. Principle

`ModelSelection` is the persistable Session/Submission intent for which Model to create later; it is not the executing model fact. Each model step creates and holds exactly one immutable Active Model; its Context, tool projection, budget, Adapter and request read the same Model:

```text
Session / Submission ModelSelection -> ModelFactory
   -> immutable Active Model -> Context / Tools / Request
```

- No Context Model Snapshot, Execution Model Binding, Provider Snapshot or capability DTO.
- Active Model is not persisted; Registry updates affect only Models created later.
- A Session Selection change during an active Turn affects only the next created Model.
- `contextSourceSnapshot` keeps cwd, platform, Shell, Git, Instructions and other legal Context Sources but no longer stores or derives the executing model.
- External methods are `getSessionModelSelection()` / `setSessionModelSelection()`, making clear it is the session selection for future Turns, not the current Active Model.

## 3. Design

### 3.1 Turn admission

Normal Turn, Compact and execution-scoped Off-Peak freeze the Selection before the first async wait and create this turn's Active Model once. Then Context init/rebuild takes the Model explicitly; the SessionStart Hook reads that Model's Provider/Model identity; the Submission's Session Selection write and event publishing reuse the created Model; Regular Loop, Memory Recall, Compact, tool projection and the request use the same object. Commands that issue no model request (such as Rewind) do not require an executable Model.

### 3.2 Context prefix

The `refreshContextModelSnapshot` semantics (sync Session Selection into Context) are deleted. The generic Context-prefix rebuild stays for real Context Source changes (language, output style, Shell, Rewind); a rebuild belonging to a model step must be passed that step's Active Model. The Context Builder generates only from an explicit Model: the Provider/Model description in the final Prompt (not through environment fields) and model-dependent projections such as `guidanceToolNames`. It never calls `getSessionModelSelection()` to guess the executing Model.

### 3.3 Guide model step

Guide switching creates a new Active Model. Before the next request, the Context prefix is re-projected with that Model and the current Turn's request-local prefix is replaced; committed user, assistant, tool and reminder tails stay. Whether Session Selection updates follows Guide's existing semantics.

### 3.4 Subagent

A Subagent inheriting the parent Model derives child Selection, child prompt model identity and child ModelFactory from the actually passed parent Active Model, not the parent Session Selection. An explicit profile/override creates its own Model.

## 4. Final scope after review (same root cause)

### 4.1 Three facts

```text
Session Model Selection
├─ persistent intent for later session execution; may change, persist, restore
├─ does not describe the currently executing model
└─ App uses it once only to initialize an existing Session lacking a Composer Draft

App Composer Draft (Todo 71)
   | frozen once at user submit; admission never reads Session to back-fill
   v
Submission Model Selection
├─ Provider / Model / Reasoning chosen by this submitted input
├─ frozen while queued
└─ handed to ModelFactory when the model step starts
   v
immutable Active Model
├─ the only execution fact of the current model step
├─ Context model description and model-dependent tool projection
├─ Adapter, model attributes and request Options
└─ not persisted; Registry updates do not change an existing object
```

The Draft path describes App only; CLI, Bot, automation and off-peak entries generate complete execution input by their own contracts and are not forced onto App Draft nor allowed to overwrite a frozen Submission. Session acceptance updates never overwrite a Draft being edited. The Runtime's old `getModelSelection()`/`setModelSelection()` became the `...Session...` names; internal copying only guards against later mutation of the same JS object and creates no business fact.

### 4.2 Remove the `EnvInfo.currentModel` back door

`ContextSourceSnapshot.envInfo` used a generic type with an optional `currentModel`, and the Builder ignored/deleted it and re-generated it from the Active Model, leaving a misleading second entry. Final:

```text
Context Source Snapshot: cwd / platform / shell / OS / Git facts
Active Model: Provider / Model identity -> Context render generates the model description
```

- Context Source requests, snapshots and persisted data no longer accept or store `currentModel`.
- The Builder's `_ignoredCurrentModel` stripping and the pre-persist `delete currentModel` bridge are removed; Subagent no longer hand-writes child Selection into `envInfo`.
- Main Agent and Subagent model descriptions still appear in the final Prompt, fed only by that model step's Active Model.
- Protocol fields of the same name used only for legacy UI display or compatibility serialization, outside Context Source, are not removed blindly.

### 4.3 First-turn Context built once

The old path ran `ensureContextInitialized(activeModel)` (creates Builder, loads Source/Skills/Memory, initializes history) and then `rebuildContextPrefix(activeModel)` immediately, creating the Builder twice. Now mutually exclusive: not initialized -> `ensureContextInitialized(activeModel)` once; already initialized -> `rebuildContextPrefix(activeModel)` for a new model step. Later normal Turns, Guide new model steps and other prefix-updating paths still rebuild.

### 4.4 Queue invariant

A queued message stores the complete Submission Model Selection at enqueue. After Session Selection changes, the head-of-queue consumption opens a new Turn using the enqueue-time Provider / Model / Reasoning, while Provider Config is read at Active Model creation time. The old claim "queued messages use the latest Session Selection at consumption" is deleted. `sendQueuedNow`, default immediate guidance and Guide/Queue product semantics are paused: no protocol or implementation change here.

### 4.5 Excluded: `outputStyle`

`outputStyle` can read different values at different places in one turn during async Context initialization. That is an existing generic Submission-parameter consistency issue, not part of this refactor; it needs its own Todo if pursued.

## 5. Implementation outcome

- A Turn creates the unique Active Model from the admission Selection before the first async wait; Context init and prefix rebuild, SessionStart Hook, Submission state application and the formal request reuse it.
- `setSessionModelSelection()` updates only future-Model intent; `refreshContextModelSnapshot` is deleted.
- Context Source no longer stores the executing model; `currentModel` and model-dependent tool hints come only from the Active Model passed explicitly by the current model step. Builder receives the Active Model directly.
- Execution-scoped Off-Peak uses its own Model and Context without rewriting Session Selection; Guide updates Model and request-local Context at the next model step; Subagent derives child Selection from the actually inherited parent Active Model and reuses it.
- The redundant Built-in Tool refresh on Session Selection switch was removed; tool visibility is still decided at request time by `getTools(activeModel)`.

## 6. Invariants and verification

Directly verified chains: ordinary Turn explicit Provider/Model switch; Guide-started new model step in one Turn; execution-scoped Off-Peak; Subagent inheriting the parent Active Model and explicit override; first-turn Context init, later prefix rebuild and SessionStart Hook; model-dependent tool projection and Adapter request using the same Active Model. Invariant-only (no implementation expansion): ordinary Queue stores a full Submission Selection and uses it in a future new Turn; Registry/Personal Config updates affect only later Active Models; Desktop `continuous` and Mobile `replayable` only carry the same committed Submission and add no model-selection derivation of their own; Session cold restore restores Selection, not Active Model; Compact, Memory and title generation explicitly create and use their own Active Model without reading Context model fields.

Tests (Core regressions plus additions): legacy-fixture Context Source input cannot become the current model fact; Subagent env info carries no second model identity; first Turn initializes the Context Builder once and later Turn/Guide rebuild once at a legal model-step boundary; queued Submission keeps Provider/Model/Reasoning after the Session Selection changes; real-device regression: on one Session on the MacBook Pro, three consecutive switches among same-modelId, different-Provider models, where the first request after each switch has the UI model-change marker, the Context model description and the Adapter request all on the target Provider (no "previous Provider" lag).

Layers: Core unit (freeze/init/Context/Queue), Bootstrap integration (Submission -> ModelFactory -> Context -> Adapter), Desktop E2E / MacBook Pro real device (first message after consecutive switches has no lag). The Air was only the origin of the original issue; verification runs on the Pro (the A -> B -> C -> A request and Context were consistent, and a second rerun strengthened the marker-target assertion; see `68-72-implementation-report.md` in this directory).

Results: Core full 2213 passed (an earlier run: 2207 passed / 36 skipped / 2 todo); final Bootstrap targeted 82; `@zcode/core` and root `pnpm typecheck`, root `pnpm lint` (existing warnings only) and `git diff --check` pass. Repo-wide `pnpm fmt:check` is blocked by existing Electron fiddle invalid HTML and `apps/zcode-cli/tests/gb2312.js`.
