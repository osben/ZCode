# Todo 28: Model Rule Precedence and Provider/Model Order Normalization Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: post-implementation reverse review after Todo 21/23
>
> Related tasks: [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md),
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md),
> [`Bugfix 02`](./bugfix-02-provider-reorder-drop-flicker.md)

## 1. Task Positioning

Todo 21 established Model Rule deferred override and Provider/Model three-segment order; Todo 23 completed Model
editing Host Preview and atomic save. Review found two mechanical implementations not yet satisfying the decided
semantics: Effective Model Rules concatenated the Personal Rule original array directly (so Personal exact Rules were
not guaranteed to be deferred), and Provider/Model write-side normalization put the requested order first and then
appended missing members, inconsistent with the Resolver's "unsorted Built-in first" three-segment semantics. This is
a consolidation Bugfix; Rules, Overlay, Settings Preview and drag interactions are not redesigned.

## 2. Boundaries with neighboring Todos

- Todo 23's Host Preview stays: Host reads the Effective Provider's real `api.type/baseURL` by `providerId` and moves
  the Personal exact Rule first in preview state; this Todo keeps only a regression proof and creates no second
  Preview interface.
- Todo 25 (ZAPI retirement), Todo 26 (Zhipu Access Type/Mode) and Todo 27 (Overlay visuals, feedback, Team state,
  Runtime Headers) are untouched.
- Bugfix 02 owns only the short-term optimistic projection from drag release to Host View confirmation; this Todo
  corrects only the final authoritative order written to Personal Config and creates no second UI Pending state.

## 3. Model Rule precedence

Effective Model Rules are combined in one fixed order:

```text
ZCode Built-in Rules (complete internal order retained)
                       +
Personal Match Rules (Personal Match internal order retained)
                       +
Personal provider-model Rules (Personal exact Rule internal order retained)
```

Used by: Registry/Resolver producing Effective Model Config; Settings new-model Preview; Settings Personal Model
Draft Preview; connection testing, ModelFactory and other indirect consumers. ZCode Built-in Rules are not reordered
(general, API, Provider and Endpoint specials follow the Built-in file author's order). Precedence is not achieved by
rewriting Personal JSON physical arrangement; one deterministic grouping happens at the domain boundary that combines
the Effective Rule array.

## 4. Provider/Model three-segment order algorithm

```text
Built-in members not appearing in requestedOrder
                       +
members still valid in requestedOrder
                       +
Personal members not appearing in requestedOrder
```

- Built-in and Personal with the same ID: Built-in wins, one member.
- Duplicates in the member array and in the requested order keep the first occurrence; stale IDs are discarded.
- The result is the complete order of all current valid members.
- `modelOrder` and `providerOrder` only sort; they do not create members, enable members or change source ownership.

Example: Built-in `[A, B]`, Personal `[P, Q]`, requested `[P, B, stale, P]` gives canonical `[A, P, B, Q]`.

For Providers the algorithm applies only to the sortable `standard-builtin/standard-personal` segment; Z.ai/BigModel
Family Providers stay a fixed front segment and are not written to Personal `providerOrder`. Models have no extra fixed
segment. The read Resolver and the write Config Service must reuse the same Provider domain pure function (or shared
test-protected vectors), not two similar algorithms differing in member position.

## 5. Write boundaries

Normalization covers every Personal Config operation that changes members or order: add Built-in Provider Personal
Overlay; create Personal-only Provider; Provider reorder and delete; normalizing history/hand-written members and
order on Provider save; add, rename, delete and reorder Personal Model; membership/order updates in Model Draft
atomic save. After any write, physical `providerOrder/modelOrder` is complete, deduplicated and free of stale IDs. The
read side keeps tolerant normalization for hand-written or abnormal intermediate states; no migration or dual-read
for the unreleased branch.

## 6. Principles

Failing tests first; delete duplicate algorithms rather than add Resolver-only and ConfigService-only helpers; no Rule
Registry, Order DTO, conflict objects, shadow Config or Renderer sort authority; Personal Match and exact Rule
internal order unchanged; Model `enabled`, Provider visibility, executable/selectable, Active Model freeze and
ModelSelection semantics unchanged; Local/Remote Host authority and Desktop continuous / Mobile replayable chains
untouched.

## 7. Acceptance

### 7.1 Rule precedence

- A Personal exact Rule placed before a Match Rule in the physical array still resolves Match first, exact after.
- Multiple Personal Match Rules and multiple Personal exact Rules each keep their internal override order.
- Built-in Rule array keeps its complete order; Personal overrides only after Built-in.
- Registry parsing, new-model Preview and Personal Draft Preview agree for the same input.

### 7.2 Order normalization

- Unsorted Built-in goes before the requested order, unsorted Personal after.
- Stale/duplicate IDs in the requested order are deleted.
- Built-in/Personal same ID keeps only the Built-in position.
- Provider and Model use the same three-segment semantics.
- Add, rename, delete, drag and Model Draft save all persist the complete normalized order.
- Bugfix 02 UI Pending rollback on a save error is unaffected.

### 7.3 Authoritative regression

- `baseURLMatch` hits correctly in Host Preview.
- An API-incomplete Provider returns a real validation issue; Renderer does not guess `anthropic-messages`.
- Preview does not modify Personal Config, order or Registry revision.

## 8. Completion and Outcome

- `ModelConfigRules.composeEffective()` is the sole Effective Rule combination boundary for the Resolver and both
  Settings Previews; physical Personal JSON no longer changes Match/exact precedence.
- `resolveOwnedOrder()` serves both the read Resolver and Provider/Model write normalization; the write-side
  requested-first duplicate algorithm is deleted; Family Providers stay in the fixed segment outside it.
- Added regression tests for Personal exact Rule physical-front placement, Provider three-segment write, and
  Facade/Registry consistency.
- `@zcode/provider` 155 tests, typecheck, lint and `git diff --check` passed; `configuration.md`, the configuration
  system summary and related Feature Graph were synchronized.
