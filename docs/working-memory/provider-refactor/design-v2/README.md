# Provider Refactor Design V2

> Status: Current design entry point
> Baseline: Provider Refactor branch implementation and ruled decisions as of this directory's creation
> Scope: Provider / Model configuration, resolution, Registry, Model creation, account overlay, settings projection, and execution boundaries

## Why V2 Was Created

Provider Refactor went through multiple rounds of design, implementation, real-machine feedback, and boundary corrections. The old `design/`, `steps/`, `research/`,
`plan/`, and implementation logs preserve the complete history, but they contain a mix of:

- Already-landed current design;
- Stage-specific designs explicitly superseded by subsequent Todo items;
- Research candidates created solely to surface issues, never adopted as design;
- Completed implementation history;
- Deferred drafts or ongoing work;
- Legacy terminology and legacy Schema inconsistent with current code facts.

This directory no longer accumulates context by migration phase. Instead, it reorganizes into two threads:

1. [`design.md`](./design.md): Records only the core design, principles, and boundaries that should currently be followed;
2. [`evidence-and-contradictions.md`](./evidence-and-contradictions.md): Records evidence sources, historical contradictions, ruling results,
   staging differences, and unfinished items, for verification and audit.

## Authority Order

When conflicts arise, apply the following priority:

1. The latest explicit user rulings and subsequently accepted designs;
2. Implementation facts demonstrated by the current domain Schema, Resolver, Registry, ModelFactory, and their tests;
3. The current design in this directory;
4. Content in the old `design/` that has not yet been superseded by subsequent decisions or code;
5. Final conclusions from completed Todo / Bugfix items;
6. Research, Draft, Delayed Todo, implementation logs, and historical plans.

Item 2 can only prove "what is currently implemented"; it cannot override Item 1. When implementation diverges from a ruled design, record it as implementation drift and fix the implementation—do not elevate accidental code behavior into design.

## How to Read

- To understand what Provider Refactor ultimately solves and why the system is layered this way: read [`design.md`](./design.md).
- To determine whether an old field, old term, or old Todo is still valid: check
  [`evidence-and-contradictions.md`](./evidence-and-contradictions.md).
- To review specific migration processes, test evidence, or historical incidents: return to the `steps/`, `research/`, and `plan/` directories at the parent level.

## Maintenance Rules

- New Provider core design decisions update `design.md` first, then implement code.
- When old materials conflict with the current design, do not alter historical materials; add ruling records to the evidence document instead.
- Only content that has completed ruling and entered the current target scope may be written into `design.md`.
- Draft, Delayed, Research, or implementations that are in progress but unverified must remain in the evidence document's unfinished section.
- This directory does not introduce new domain objects; "V2" refers only to the documentation organization version, not a runtime version, Config Schema version, or migration protocol.
