# Todo 28: Model Rule Precedence and Provider/Model Order Normalization Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Post-implementation reverse review after Todo 21/23 completion
>
> Related tasks: [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md),
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md),
> [`Bugfix 02`](./bugfix-02-provider-reorder-drop-flicker.md)

## 1. Task Positioning

Todo 21 has established Model Rule deferred override and Provider/Model three-segment order, Todo 23 has completed Model editing
Host Preview and atomic save. Post-completion review found two mechanical implementations still not fully satisfying decided semantics:

1. Effective Model Rules still directly concatenate Personal Rule original array, cannot guarantee Personal exact Rules always deferred;
2. Provider/Model write-side normalization puts requested order first, then appends missing members, inconsistent with Resolver's "unsorted
   Built-in first" three-segment semantics.

This Todo is a consolidation Bugfix for existing design, not redesigning Rules, Overlay, Settings Preview, or drag interactions.

## 2. Boundaries with Recent Todos

After verification, no product design conflicts, boundaries fixed as:

- Todo 23 completed Host Preview: Host reads Effective Provider's real
  `api.type/baseURL` by `providerId`, and moves Personal exact Rule first in preview state; this Todo only retains regression proof, no second
  Preview interface created;
- Todo 25 completed ZAPI product entry retirement, not included in this Todo;
- Todo 26 only changes Zhipu Access Type/Mode, does not change Model Rule precedence or order member semantics;
- Todo 27 handles Model Overlay visuals, success feedback, Team state, and Runtime Headers, does not modify this Todo's domain algorithms;
- Bugfix 02 only manages short-term optimistic projection from drag release to Host View confirmation; this Todo only corrects final write
  Personal Config authoritative order, does not create second UI Pending state.

## 3. Model Rule Precedence

Effective Model Rules' sole combination order fixed as:

```text
ZCode Built-in Rules (complete retention of Built-in internal order)
                       +
Personal Match Rules (retain Personal Match internal order)
                       +
Personal provider-model Rules (retain Personal exact Rule internal order)
```

This order used simultaneously for:

- Registry/Resolver producing Effective Model Config;
- Settings new model Preview;
- Settings Personal Model Draft Preview;
- Connection testing, ModelFactory, and other indirect consumption Effective Model Config chains.

Do not reorder ZCode Built-in Rules themselves; general, API, Provider, and Endpoint specials within Built-in still determined by Built-in file
author order. Do not achieve precedence by rewriting Personal JSON physical arrangement; perform one deterministic grouping at the domain boundary of combining Effective Rule
array.

## 4. Unique Algorithm for Provider/Model Three-Segment Order

For any ordered set possessing Built-in and Personal members, result fixed as:

```text
Built-in members not appearing in requestedOrder
                       +
members still valid in requestedOrder
                       +
Personal members not appearing in requestedOrder
```

Simultaneously obeying:

- Built-in and Personal same ID means Built-in wins, only one member;
- Duplicates in member array and requested order both retain first occurrence only;
- Stale IDs directly discarded;
- Result is complete order of all current valid members;
- `modelOrder` and `providerOrder` only sort, do not create members, do not enable members, do not change source ownership.

Example:

```text
Built-in = [A, B]
Personal = [P, Q]
Requested = [P, B, stale, P]

Canonical = [A, P, B, Q]
```

Provider's algorithm only applies to sortable `standard-builtin/standard-personal` segment; Z.ai/BigModel Family
Provider stays fixed front segment, not written to Personal `providerOrder`. Model has no extra fixed segment.

Read Resolver and write Config Service must reuse same Provider domain pure function or shared test-protected
vectors, must not continue maintaining two similarly appearing but member-position-different algorithms.

## 5. Write Boundaries

Above normalization must cover all Personal Config operations modifying members or order:

- Add Built-in Provider Personal Overlay;
- Create Personal-only Provider;
- Provider reorder and delete;
- Normalize history/hand-written members and order when saving Provider;
- Add, rename, delete, and reorder Personal Model;
- membership/order updates in Model Draft atomic save.

After any write completes, physical `providerOrder/modelOrder` should already be complete, deduplicated, stale-ID-free normalized results.
Read side retains tolerant normalization to handle user hand-written or abnormal intermediate states; no migration or dual-read created for unreleased branches.

## 6. Implementation Principles

- Write failing tests proving Personal Match/Exact precedence and three-segment write differences first, then modify production code;
- Prioritize deleting duplicate algorithms, no longer adding Resolver-only and ConfigService-only helpers;
- Do not create Rule Registry, Order DTO, conflict objects, shadow Config, or Renderer sort authority;
- Do not change Personal Match Rule internal order, do not change exact Rule internal order;
- Do not change Model `enabled`, Provider visibility, executable/selectable, Active Model freeze, or ModelSelection semantics;
- Do not affect Local/Remote Host authority boundaries, do not touch Desktop continuous or Mobile replayable chains.

## 7. Test Plan

### 7.1 Rule Precedence

- When Personal exact Rule located before Match Rule in physical array, effective parsing still Match first, exact after;
- Multiple Personal Match preserve original internal override order;
- Multiple Personal exact Rules preserve original internal override order;
- Built-in Rule array preserves complete order, Personal still overrides only after Built-in;
- Registry parsing, new model Preview, and Personal Draft Preview get consistent results for same input.

### 7.2 Order Normalization

- Unsorted Built-in placed before requested order, unsorted Personal placed after;
- Stale/duplicate IDs in requested order deleted;
- Built-in/Personal same ID retains Built-in position only;
- Provider and Model use same three-segment semantics set;
- Add, rename, delete, drag, and Model Draft save all persist complete normalized order;
- Bugfix 02 UI Pending rollback when save abnormal, not disrupted by this Todo's domain algorithm.

### 7.3 Authoritative Regression

- `baseURLMatch` correctly hits in Host Preview;
- API-incomplete Provider returns real validation issue, Renderer does not guess `anthropic-messages`;
- Preview does not modify Personal Config, order, or Registry revision.

## 8. Completion Criteria

- Effective Rules obey `Built-in + Personal Match + Personal provider-model` in all parsing surfaces;
- No two semantically different order helpers exist between Resolver and Config Service;
- All order write boundaries produce complete, deduplicated, stale-ID-free normalized order;
- Todo 23 completed Host Preview boundary unchanged;
- `configuration.md`, configuration system summary, and related Feature Graph synchronized, no longer claiming write normalization
  completed while code still uses another algorithm;
- Provider directed unit tests, `pnpm typecheck`, `pnpm lint`, modified file format check, and `git diff --check`
  pass;
- Submit Conventional Commit upon completion.

## 9. Implementation Results

- `ModelConfigRules.composeEffective()` becomes sole Effective Rule combination boundary for Resolver and both Settings Previews, physical Personal JSON no longer changes Match/exact precedence;
- `resolveOwnedOrder()` serves both read Resolver and Provider/Model write normalization simultaneously, deletes write-side requested-first
  duplicate algorithm; Family Provider continues outside fixed segment;
- Added Personal exact Rule physical front, Provider three-segment write, and Facade/Registry consistency regression tests;
- `@zcode/provider` 155 tests, typecheck, lint, and `git diff --check` passed.
