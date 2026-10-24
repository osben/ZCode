# Conversation Session Requirement Matrix Workflow

Defines the "requirement clarification branch" instance for the conversation session domain. The generic entry is the `.agents/skills/feature-boundary-planner` skill: the user first describes the function to add or adjust, the Agent finds related concepts from existing documents and code, enumerates state combinations formally, prunes them step by step with the user, and finally produces the case documents that need coverage.

## Goal

- Turn "I want to change a feature" into a reviewable state space rather than writing E2E directly.
- Generate candidate combinations with the existing protocol, case catalog, coverage matrix and formal-proof basis.
- Record separately in documents the combinations the product has confirmed, those still to be confirmed, those explicitly pruned and those not covered for now.
- Hand only `accepted` cases to the later E2E manual-review / promotion pipeline.

## Input

The user only needs to give a natural-language change first, for example:

```text
While running, a message in the queue can be sent immediately
```

If the description is insufficient, the Agent first asks only the minimum necessary question, e.g. "is this a fix of existing behavior or a new entry?"

## Context discovery

Find product semantics from documents first, then read code to confirm the current implementation and observable evidence:

1. Protocol layer: `docs/conversation-protocol-declaration.md`
2. Case catalog: `docs/conversation-session-case-catalog.md`
3. Coverage matrix: `docs/testing/conversation-session-e2e-coverage-matrix.md`
4. Related dedicated matrices: fork, goal, fault, tool cross-product, network/SSE, recovery/isolation, etc.
5. Current implementation: UI surface, store/runtime state, protocol event, fixture/helper

Output a concept map recording where each concept comes from and why it relates to this requirement.

## Dimension extraction

Collect only dimensions that change the product result or an assertion. Common dimensions:

| Type                  | Examples                                                                             |
| --------------------- | ------------------------------------------------------------------------------------ |
| Product state         | `session.phase`, `queue.length`, `queue.autoDrain`, `goal`, `compact.origin`         |
| Input event           | send text, `/goal`, `/compact`, stop, edit, fork, queue send-now                     |
| Target object         | latest turn, old turn, assistant message, user query, queue item                     |
| Entry surface         | composer, turn actions, queue actions, toolbar, goal control                         |
| Run shape             | text streaming, tool call, compact pending, goal verification                        |
| Configuration/environment | model/provider/thought, desktop continuous, web remote replayable, Docker replay |
| Evidence layer        | UI, runtime/store, protocol, network/SSE, files, logs                                |

If a dimension is fully absorbed by an invariant, do not permute it fully, but record the pruning reason and a representative case.

## Enumeration and pruning

The enumeration view follows the formal-proof structure:

```text
state -> candidate -> guard -> effect -> case
```

First take the Cartesian product of the relevant dimensions, then prune by guards and invariants. Every candidate combination must fall into one state:

| State           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `accepted`      | Product semantics are clear, setup/action/assert can be written     |
| `undefined`     | Can really happen but the product semantics are not confirmed       |
| `pruned`        | Explicitly cut by a guard or invariant                              |
| `ignored`       | Exists but is not covered by the current version; the scope reason must be written |
| `bug-candidate` | The current implementation seems to violate a confirmed protocol    |

The Agent takes only a small batch of questions to the user at a time, to avoid dropping a huge matrix at once. Questions include candidate answers and the impact area, and documents are written back after the user answers.

## Document output

One requirement clarification produces or updates at least:

1. `docs/conversation-session-case-catalog.md`: add/update natural-language cases.
2. `docs/testing/conversation-session-e2e-coverage-matrix.md`: mark accepted but unimplemented cases as `missing` or `planned`.
3. If there are undefined items: add or update the decision worksheet/backlog, stating the question, candidate bases and backfill targets.
4. For a dedicated dimension: sync the matching dedicated matrix rather than stuffing all combinations into the main-path matrix.

An accepted case in the documents must contain setup, action, assertion and at least one non-UI evidence layer. Merely passing through a state along some path does not count as coverage.

## E2E handoff

Only `accepted` cases enter the E2E landing flow:

1. Generate a `manual-review/pending` spec.
2. Run manual/capture and review by a human.
3. Curate case-local provider/file fixtures.
4. After promotion, enter the formal replay and the Docker suite.

This follow-up flow is owned by the `.agents/skills/e2e-case-lifecycle` skill. The requirement clarification branch does not generate formal E2E directly and never writes `undefined` as a test assertion.
