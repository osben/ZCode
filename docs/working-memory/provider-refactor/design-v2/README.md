# Provider Refactor Design V2

> Status: Current design entry point
> Scope: Provider / Model configuration, resolution, Registry, Model creation, account overlay, settings projection, and execution boundaries

Provider Refactor went through multiple design, implementation, feedback, and correction rounds. The old
`design/`, `steps/`, `research/`, and `plan/` directories preserve that history: landed designs, superseded
stage designs, issue-surfacing research, implementation logs, deferred drafts, and legacy terminology that
no longer matches the code. This directory reorganizes the result into two threads:

1. [`design.md`](./design.md): the core design, principles, and boundaries to follow now;
2. [`evidence-and-contradictions.md`](./evidence-and-contradictions.md): evidence sources, historical
   contradictions, rulings, staging differences, and unfinished items, for verification and audit.

## Authority Order

When conflicts arise, apply this priority:

1. The latest explicit user rulings and subsequently accepted designs;
2. Implementation facts in the current domain Schema, Resolver, Registry, ModelFactory, and their tests;
3. The current design in this directory;
4. Content in the old `design/` not yet superseded by later decisions or code;
5. Final conclusions from completed Todo / Bugfix items;
6. Research, Draft, Delayed Todo, implementation logs, and historical plans.

Item 2 only proves "what is currently implemented"; it cannot override Item 1. When implementation diverges
from a ruled design, record it as implementation drift and fix the implementation — do not elevate accidental
code behavior into design.

## How to Read

- For what Provider Refactor solves and why the system is layered this way: read [`design.md`](./design.md).
- To check whether an old field, term, or Todo is still valid: read
  [`evidence-and-contradictions.md`](./evidence-and-contradictions.md).
- For migration processes, test evidence, or incidents: use the parent-level `steps/`, `research/`, and
  `plan/` directories.

## Maintenance Rules

- New Provider core design decisions update `design.md` first, then implement code.
- When old materials conflict with the current design, do not alter them; add a ruling record to the
  evidence document instead.
- Only ruled content inside the current target scope may be written into `design.md`. Draft, Delayed,
  Research, and unverified in-progress implementations stay in the evidence document's unfinished section.
- This directory introduces no new domain objects; "V2" is a documentation-organization version only, not a
  runtime, Config Schema, or migration-protocol version.
