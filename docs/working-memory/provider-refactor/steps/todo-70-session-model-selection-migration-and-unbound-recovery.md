# Todo 70: Session Model Selection Migration and Unbound Recovery

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation and phase acceptance done (2026-09-04).
>
> Source: post-mortem of stored-Session restore failures before the Provider refactor shipped.
>
> Order: Todo 72's identity conversion first, then link to Todo 69's storage boundary; this Todo next; Todo 71 last. Follows Todo 69's "no continuous dual-write" rollback boundary and does not rely on an old-field write-back encoder.

## 1. Problem

When a stored Session is restored, its persisted Model Selection may be in the old structure; in the new structure without `reasoningLevel`; referencing a Provider, Model or Reasoning that no longer exists; or hold old and new fields with different content. The restore chain handed such an incomplete Selection to the strict ModelFactory too early, so even the history could not be opened:

```text
Reasoning level is required for provider/model
```

This is not a model-request failure: Session restore and execution model binding were not separated.

## 2. Goal

1. Migrate old Sessions to the current Model Selection at the persistence read boundary where possible; no bulk rewrite of history and no old-field dual-write for downgrade rollback.
2. Session restore reads only the migrated new fields. What can be determined restores normally; what cannot stays unbound, but never blocks opening the Session or viewing history.

This Todo owns only Session upgrade reads and restore, not other domains' upgrade logic. Todo 69 narrowed to the physical compatibility boundary of downgrade rollback (the only production change is Bot Config/State file isolation); it no longer promises per-domain continuous dual-write, and other domains' upgrade migrations are not thereby complete.

Old Provider identity conversion follows [Todo 72](./todo-72-legacy-builtin-provider-and-model-selection-migration.md). The dynamic identity of an old Coding Plan may be converted to the personal/Team connection currently selected for the same Family at migration time; this is an old-structure upgrade rule, not an Account-first fallback after a current Selection becomes invalid. This Todo remains the single Decoder and unbound-recovery owner; no parallel conversion entry, and old fields never patch an existing current structure.

### 2.1 Shared principles (with Todo 69)

1. Migrate old data where possible.
2. Old raw data is not destructively bulk-cleaned, but old fields are not generated continuously; rollback degradation follows Todo 69.
3. Current restore recognizes new fields only.
4. Determinable missing values are filled directly; undeterminable ones may stay empty.
5. Invalid selections are never auto-replaced; an empty model or Reasoning shows no notice and is expressed by the control's empty state.
6. Corrupt model-selection data must never make a whole Session unopenable.

Three behaviors:

- **Migrate**: old and new fields correspond one-to-one, move the same value mechanically.
- **Fill**: the new field is uniquely determined by the same persisted fact, write it directly.
- **Replace**: the original value is invalid and the system switches to another Model, Provider or Reasoning.

Migration and deterministic filling do not change the user's choice. Invalid Model/Provider/Reasoning is not auto-replaced: it stays unbound awaiting user selection, with no invalidation notice. Configured Default, model-rule defaults, `values[0]`, `values.at(-1)`, the first list item and history messages are never "determinable missing values".

```text
legacy Session persistence
  -> persistence read boundary
     +-- truly legacy structure --> convert to current Model Selection
     `-- current structure present --> adopt only the current structure
  -> Session restore
     +-- Selection complete and valid --> bind execution Model
     `-- Selection missing/invalid --> stay unbound, Session opens normally
                                       -> user re-selects, then binds
```

## 3. One-way storage migration and current writes

### 3.1 Read priority

- With a current Model Selection present, read only current fields; never supplement it from the old `thoughtLevel`, old message fields, restore hints or other side paths.
- Only when the data has no current structure at all and is clearly a legacy Session does the compatibility Decoder read old fields and convert. Old fields that determinably express Provider, Model and Reasoning convert normally; information the old structure lacks stays missing, no guessing.

"Current structure" is not judged only by the existence of a `modelSelection` field: the old version may already write it with an explicit old `builtin:*` identity. Such data with legacy-format/reserved-identity evidence is converted at the upgrade boundary per Todo 72, then restored as a current selection. Current-field precedence still holds: convert the identity it itself determines, but do not patch it from a neighboring old `thoughtLevel`. An ordinary unknown ID or a temporarily unavailable Registry is not evidence of old data.

Old fields supply upgrade input only in the legacy-record Decoder and are not a second fact source for restore; they need not be bulk deleted, but once the current version sees the current structure it ignores old fields even if the current structure is incomplete.

### 3.2 Write rules

Writes keep going through the single Session Store boundary: the current Model Selection is authoritative; write only the current structure, never derive old message aliases or the old `thoughtLevel` from it; the current Decoder's domain objects expose no old aliases; the one-way Decoder's comments describe the old structure source and current-field precedence (zh comment in the code); no rollback Encoder or generic compatibility abstraction.

No database table migration and no bulk rewrite of history; history messages migrate gradually on read and later normal write-back. If the current Session selection successfully converts an old Coding Plan dynamic identity, the new identity is fixed during this restore through the existing save entry, without waiting for the next user message; Reasoning that cannot be determined may stay empty. Only the current selection is written; historical request identities are not changed and old fields are not written back. Writes keep the existing serialization/concurrency protection so a selection the user saved during restore is not overwritten; a write failure is never reported as migration done and does not block history opening (handled as an existing storage error log/feedback, a different class from the "empty, no notice" rule).

Storage uses a narrow `migrateLegacyModelSelection` operation: the Adapter recognizes the raw old structure; identity conversion is injected by the caller reusing Todo 72's rules; the Adapter reads no account files and guesses no Registry order. It reads the candidate first, then obtains the identity conversion asynchronously; inside the write transaction it re-checks the candidate and current selection and abandons the old result if they changed. An existing current entry (even incomplete) outranks history messages. Only with no current entry and the latest selection evidence clearly in the old structure may an old message be imported. On success it is saved as the existing current selection entry without modifying messages or Session activity time.

The protocol host returns the current ID for an old Provider through the upgrade-only `session/resolveLegacyModelProvider` (input only `sessionId/providerId`, no credentials). The request is bound to the Workspace CLI/Host connection that produced it; the Host interprets the old Coding Plan with the account connection of its own Environment, not forwarded to the desktop UI preference-resolution chain. Standalone with no account host can still convert static legacy identities while a dynamic Coding Plan stays unbound. It is not a Provider-alias interface for normal execution: only real legacy-structure import calls it, and not after the new entry is fixed. Desktop continuous / Mobile replayable subscription, owner routing and queues are unchanged; mobile starts no separate Host.

## 4. Session restore behavior

### 4.1 Complete and valid

Provider, Model and Reasoning all still valid: restore as is and bind the execution Model.

### 4.2 Reasoning missing or invalid

Keep the still-valid Provider/Model identity but treat the Selection as unfinished: only clear a missing `reasoningLevel` or one no longer in the current `values`, never touching a valid `providerId/modelId`; no auto-pick via `values[0]`, `values.at(-1)` or Configured Default; no guessing from old fields or history messages; the Session opens normally; the UI shows the unfinished model selection and execution continues only after the user re-selects Reasoning.

### 4.3 Provider or Model invalid

The same "Selection unbound" semantics: no replacement by the Account Provider's first model, Configured Default or any other candidate; clear the unresolvable execution binding; the Session opens with all history; the user re-selects an available model to continue.

Reasoning invalidity and Provider/Model invalidity are not two restore systems: the former can keep the model identity, the latter cannot bind the identity either. Both reuse the same Selection validator and control empty-state rule but keep this level difference: Reasoning invalidity must not clear the whole Selection or switch to another Provider/Model. History restore and Todo 71's active Draft are both left empty, with no two invalidation fallback strategies. An empty model or Reasoning shows no Toast, dialog or extra banner and keeps no notification de-dup state; the user completes it through the selection control. Genuine execution, submission or storage fault feedback is not removed.

### 4.4 Unbound is not a half-built Model

```text
Session history restore
  +--> completes independently, no Active Model required
  `--> user starts the next execution
        +-- Selection complete --> create Active Model
        `-- Selection unbound  --> require the user to complete the selection
```

Do not loosen ModelFactory, restore a Runtime fallback or build an Active Model lacking Reasoning.

### 4.5 Concrete representation and state ownership

"Unbound" is not a new persisted format nor a half-built Active Model; it only says the Session history is restored but there is no complete Selection that can go to ModelFactory:

```text
Session opened successfully
├─ history messages: restored
└─ execution binding
   ├─ Selection complete and valid --> Runtime holds the complete Session Selection
   ├─ Reasoning missing/invalid ----> keep Provider/Model for Composer repair
   `─ Provider/Model invalid -------> Runtime has no Session Selection
```

- The persistence Decoder keeps returning the current Selection candidate it can determine; no `unbound: true` database field.
- Only a complete Selection validated by the current `ModelSelectionView` is written into the Runtime Session Selection and may create an Active Model.
- Reasoning missing/invalid: the result keeps the valid `providerId/modelId`, clears only `reasoningLevel` as the Composer's pending selection; Runtime must not bind it into an executable Model early.
- Provider/Model invalid: both Runtime and Composer executable Selections are emptied; the old identity may be used only in diagnostics logs, never request routing.
- The invalidation level is recomputed against the latest Registry at restore time and surfaced through the existing restore result as the UI empty state; no invalidation notice and no persisted `selectionIssue` that could go stale.
- History display never depends on Selection. Only after the user re-selects a complete Provider/Model/Reasoning does the Session Selection update and execution resume.

No public `UnboundSelection`, Execution Binding or second model DTO is added. In implementation, the Runtime Session Selection may be absent, and execution entries reject a missing selection before calling the strict ModelFactory. A history message's model-source field may also be absent (old data may have none; synthesized timelines from restore may never have run a model request); a default model is never borrowed to forge a source, and real model output still records its source from the turn's Active Model.

## 5. Boundaries with existing behavior

- New Sessions and normal user model selection still generate complete Selections by the formal rules; the default level rule is unchanged.
- Connectivity tests, title generation, Git and other auxiliary requests keep Todo 67's `values[0]` and are unrelated to stored-Session restore.
- An Active Model stays frozen once created; Registry updates do not modify running Turns.
- Session mode, message content, Compact, queues and tool restore are out of scope.
- Todo 69 ruled that Session, off-peak and automation do not continuously dual-write; this Todo keeps the one-way legacy-Session Decoder and does not restore downgrade writes.

## 6. Test scope (written first)

1. A Session with only old fields decodes into the current Model Selection.
2. With old and new fields both present, only the current field applies; old fields cannot supplement or overwrite it.
3. Old-structure values with a one-to-one mapping migrate mechanically; undeterminable fields stay missing.
4. Current Selection lacking Reasoning: Session opens, history complete, Provider/Model unchanged, execution unbound.
5. Current Reasoning no longer in the model `values`: only Reasoning cleared, Provider/Model unchanged, awaiting user re-selection.
6. Provider or Model gone: Session opens, no automatic switch to another model.
7. After the user completes model and Reasoning, an Active Model is created and the conversation continues.
8. Unbound state and the invalidation reason are not persisted; reopening after the Registry recovers re-validates against the latest View.
9. Cold restore, reconnect, Fork and continued execution of a current complete Selection do not regress.
10. Write-back uses only the current structure with no old message aliases; the one-way legacy Decoder stays valid (Todo 69 non-dual-write boundary).
11. Empty model/Reasoning shows no notice; after handing to Composer, switching pages or restart it is not auto-filled by default initialization.
12. A legacy `modelSelection` with an explicit old built-in identity converts normally; a currently unknown identity triggers no guessing and side-path old fields do not fill.
13. After a first migration to the personal connection, closing without sending and reopening after switching to Team still reads the fixed personal identity (empty if unavailable) and is not re-migrated to Team; a write failure or concurrent new selection is neither misreported as success nor overwritten by the old result.

Desktop interaction adds E2E: open a stored Session whose Selection is invalid, view history, re-select a model and continue sending.

## 7. Completion criteria

- No missing or invalid Model Selection blocks Session opening or history viewing.
- Restore consumes only the current Model Selection; old fields do not become a fact source again; truly old Sessions still migrate through the single storage Decoder.
- The system never silently picks Model or Reasoning for the user; empty shows no invalidation notice and stays empty after handing to Todo 71 (no auto default model).
- An unbound Selection never enters the strict ModelFactory; after the user completes the selection the original Session continues.
- Todo 69's practical rollback capability holds; tests, typecheck, lint, diff check and related E2E pass.
