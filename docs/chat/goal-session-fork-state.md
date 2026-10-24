# Goal Session Fork State

Forking a goal session is not a pure transcript copy. A running goal is expressed by four persisted state kinds:

- `session_target`: the target itself, status, budget and accumulated statistics.
- model-only `goal-continuation` user message: the boundary input that lets the model continue the next goal round.
- assistant message: the visible output of each goal round.
- `target_completion_verification` session entry: verifier lifecycle, iteration, anchor assistant and verification result.

If fork copied only messages and then called `setTarget`, the child would get a new `targetId` and an empty verifier timeline. After the UI filters model-only continuations, several assistants would look like one goal iteration and history projection would merge them into one assistant.

## Semantics

- Forking a goal session copies the goal state before the fork point; it does not create an empty goal.
- The child's target identity must align with the copied continuation/verifier metadata.
- Only verifier entries whose anchor assistant is already in the child transcript are copied; verifier entries after the fork point must not enter the child.
- A copied verifier entry's `anchorAssistantMessageId` is rewritten to the child message id.
- The child's goal completion state derives from the copied verifier results: only a latest copied verifier that passed yields `complete`; the child is never marked complete because the parent finished later.
- Fork does not copy the parent queue and does not auto-start a model turn.

## Implementation constraints

- Fork state copying happens in the agent core fork path, which owns both the transcript cut and the parent-to-child message id map.
- The bootstrap/protocol layer must not overwrite the child target with `setTarget` after the core fork. `setTarget` means create/replace a target and does not suit a fork state branch.
- Active goal run fields are not copied to the child, so it does not inherit the parent's running `activeInputId` / timer.
