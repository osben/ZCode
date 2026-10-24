# Todo 42: Auxiliary Model Reasoning and Output Budget Semantics Closeout

> Status: Completed
>
> Date: 2026-08-28
>
> Source: review after Bugfix 08
>
> Prerequisite: [`Bugfix 08: Auxiliary model calls uniformly use the lowest Reasoning level`](./bugfix-08-auxiliary-model-lowest-reasoning.md)

## 1. Background

Bugfix 08 moved Session Title, Goal Title, Git Commit Message and Memory Recall from "guess how to turn Reasoning
off" to using the first public Reasoning level of the current Model. A review still found residue: Git Commit
Message upstream declared `maxOutputTokens: 256` while downstream ignored it (the lowest Reasoning may need
generation budget); Adapter Telemetry still scanned level names `disabled`, `off`, `nothink`, `none` to guess
whether a level means "off"; and there was no direct proof for a model with no Reasoning Option Spec.

## 2. Semantics

### 2.1 Auxiliary-call Reasoning

```text
Model.optionSpecs.reasoningLevel: present -> use values[0]; absent -> synthesize and send nothing
```

`values` are ordered by semantic strength from low to high; the first item may be `off`, `nothink`, `low` or another
public level; Runtime and Adapter never infer "enabled" or "off" from a level name; ordinary requests keep the
user's explicit selection or the Model Config `default`.

### 2.2 Auxiliary-call output budget

Auxiliary calls use the lowest public Reasoning level and inherit the current Model's effective Max Output. No more
promise that Recall or Git Commit Message total generation stays within 256 (some models' lowest public level still
requires Reasoning, so a fixed 256 may not form a legal request). Upstream must not declare a 256-token limit that
downstream necessarily ignores; interfaces, constants, tests and docs express the same real semantics.

### 2.3 Telemetry

Telemetry records only the public `reasoningLevel` actually selected by the request. No level-name scanning and no
inferred unified enabled/disabled state; any future cross-Provider on/off semantics must be an explicit Config fact,
never restored string guessing.

## 3. Goals

1. Delete the dead 256-token parameter, constant, special-ignore logic and old assertions in the Git Commit Message
   chain.
2. General Workspace Generate Text keeps handling a caller-supplied budget under its formal contract; no fake
   parameter is kept for Git Commit Message.
3. Delete `resolveReasoningDisabledMappingKey` with all its exports, references and tests.
4. Delete Adapter Telemetry name inference of `disabled`, `off`, `nothink`, `none`; record only the actual level.
5. Clean "hidden off Mapping consumed by auxiliary calls" design wording; Reasoning Mapping is read exactly by the
   actually selected public level.
6. Prove that without a Reasoning Option Spec Title, Git Commit Message and Recall synthesize no level and do not
   change the Active Model.
7. Model Selection, Active Model freeze, Account/Personal Overlay, queue and persistence unchanged.

## 4. Not done

No fixed 256 auxiliary limit; no new Reasoning Policy, Resolver, DTO, Factory Input or request-specific Option; no
inference from Provider, Model ID, API Type or model name; no change to ordinary conversation, Compact, Subagent,
Repo Wiki or Dream parameters; no Semantic Recall opening; no change to the Off-Peak skip-Extraction decision.

## 5. Acceptance

- Git Commit Message sends no stale 256-token constraint and inherits the Model's effective budget; general Workspace
  Generate Text still honors a caller-provided `maxOutputTokens`.
- With a Reasoning spec the four auxiliary calls use `values[0]`; without one Title, Git Commit Message and Recall
  produce no `reasoningLevel`; Active Model and Session Selection are unchanged after all auxiliary calls.
- Adapter Provider Options come only from the exact `reasoningMapping[reasoningLevel]`; Telemetry no longer judges
  enabled/disabled by string aliases; the Built-in Reasoning values order integrity test still passes.
- No `resolveReasoningDisabledMappingKey` in production code and current Design; no "upstream passes 256, downstream
  ignores" contract in the Git Commit Message chain; Bugfix 08's record matches the final code.

## 6. Outcome

Git Commit Message Services no longer declare a fixed `maxOutputTokens: 256`; general Workspace Generate Text dropped
its querySource special case (an explicit caller budget runs as given, otherwise the current Model's effective
Options carry the budget). `resolveReasoningDisabledMappingKey` is deleted; Adapter Provider Options read only
`reasoningMapping[reasoningLevel]`; Telemetry records the actual level without synthesizing enabled/disabled. The Test
Model Factory gained a "no Reasoning Spec" capability, and the Session/Goal Title shared chain, Git Commit Message and
Memory Recall prove no synthesized Reasoning and unchanged Active Model/Selection. Services, Core and Adapters
directed tests 93 passed; Provider full 151 passed; root typecheck and CLI Contracts/Adapters/Core typecheck passed;
root lint 0 errors (33 unrelated pre-existing warnings). Core full had 2109 passing with remaining failures from the
existing absolute-path conformance fixture, CUA, I/O/module boundary and stream-recovery baselines; Adapters full
had 1370 passing with one unrelated process-group cleanup failure reproduced in isolation.
