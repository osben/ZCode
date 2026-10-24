# Model Execution and Inheritance

> **Implemented:** the [Off-peak background lifecycle plan](../../../../off-peak-task/background-lifecycle-plan.md)
> adjusted idle Session continuation selection, background inheritance and takeover, and made the
> accelerator-only fallback snapshot explicit. The text below describes current execution rules.

How executions obtain, maintain, or switch Models after a Submission enters Core. Selection state:
[`../interaction/interaction.md`](../interaction/interaction.md); Model creation and auth:
[`../registry/model-creation.md`](../registry/model-creation.md).

## General Principles

1. A single execution first determines ModelSelection, then creates a Model from Registry/ModelFactory.
2. Each Agent Loop holds its own Active Model.
3. The Active Model is immutable after creation, until the Loop ends or Guide switches at an explicit Step
   boundary.
4. Automatic Compact uses the current Loop's Active Model.
5. Subagents create their own Models based on the final Selection.
6. Background/Goal new main Loops use the Session Selection determined at startup.
7. Special executions attach only Request Auth, Ticket, attribution, or override; they carry no
   Provider/Model static Config.

## Execution Categories

| Execution               | Selection Source                         | Model Lifecycle                                   | Session Selection                                |
| ----------------------- | ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Normal start-now        | Current Submission                       | New Agent Loop                                    | Updated on receipt                               |
| Normal Queue drain      | Queue item's saved Submission            | New Agent Loop                                    | Updated on admission; not overwritten on dequeue |
| Guide / "Immediate"     | Guide Submission                         | Subsequent Steps in current Loop                  | Updated when Guide is received                   |
| Automatic Compact       | Current Loop Active Model                | Current Loop                                      | Not updated                                      |
| Manual Compact          | Compact Submission                       | New Loop                                          | Normal rules                                     |
| Subagent                | override > Profile > Parent Selection    | Child lifecycle                                   | Does not update parent Session                   |
| Background              | Selection determined at each round start | Current background model round                    | Not reverse-updated                              |
| Goal continuation       | Session Selection at continuation time   | New main Loop per round                           | No extra save                                    |
| Off-Peak automatic turn | idle Submission's ModelSelection         | Model rounds within the item's resident execution | Temporarily updated, not persisted               |

## Normal Agent Loop

```text
Core Submission
      |
      v
Registry / ModelFactory
      |
      v
Agent Loop Active Model
├─ Model Step 1
├─ Tool Batch
├─ Model Step 2
└─ Automatic Compact
```

Composer switching, normal Session config changes, or Registry refresh do not change the current Active
Model. New configurations are read only when creating the next Model.

## Guide / "Immediate"

Guide is an explicit switching event within the current Loop:

```text
Active Loop: Model A
        +
Guide Submission: Selection B
        |
        v
Registry creates Model B and completes admission
        |
        v
Context adds Guide input
Session Selection A -> B
Active Model A -> B (next Model Step)
```

Already-issued requests continue using A; subsequent Steps and subsequent Automatic Compact use B. Context
injection, Session Selection update, and Active Model switching form a single atomic receipt result; if any
step fails, the complete Guide falls into the ordinary Queue, not a partial submission.

## Compact

### Automatic Compact

Automatic Compact is an internal behavior of the current Loop:

```text
Current Active Model
├─ same Provider/Model Config
├─ same Model properties and limits
├─ same bound options
└─ same request-time access context
        |
        v
Automatic Compact request
```

It reads neither Composer nor Session Selection and establishes no second Provider/Capability DTO. After a
Guide switch, subsequent Automatic Compact uses the new Active Model.

### Manual Compact

Manual Compact is a new Submission/Loop creating a Model from its own Selection. It does not inherit the
ended Loop's temporary execution context.

## Subagent

Selection priority is fixed:

```text
Core Server Submission override
        >
Subagent Profile Selection
        >
Parent Loop Active Selection
```

The Child then creates its own Model from Registry:

```text
Final Child Selection
        |
        v
Registry / ModelFactory
        |
        v
Child-owned Active Model
```

Fresh/Fork defines Context initialization; Foreground/Background defines scheduling; neither changes model
inheritance. Core Server override is a general execution option that can require all Children derived from
this Submission to use a specified Selection; it is not idle-task-only and does not enter the Agent tool's
provider-visible input.

Normal Profile explicit models and reasoning parse per Subagent settings semantics. A Profile without a
model inherits the Parent's Active Selection; Children never share the Parent's mutable Model object.

## Goal

Each automatic re-run of a Goal is a new main Agent Loop:

```text
Goal Loop 1 uses Selection A
        |
User normal Submission uses Selection B
        |
Session Selection = B
        |
Goal Loop 2 starts
        `-- uses Selection B
```

Goals save no extra continuation Selections. New Loops use the Session Selection at re-run time and create
new Models through Registry.

## Background

Background creates its own Model at startup and keeps it for the current model round; a new round triggered
by message recovery or background wake-up reads the current Session Selection:

```text
Turn 1: Selection A, starts Background A
Turn 2: User Submission uses Selection B
Background A completes
Turn 3: Wake main Agent, read Session Selection B
```

Background continues using A; after completion it only triggers a new main Loop. The Background Model does
not reverse-modify Session Selection.

## Idle Tasks

Idle tasks use user-invisible but complete Built-in Providers based on the current account Family:

```text
Z.ai      -> account:zai-offpeak-idle-plan
BigModel  -> account:bigmodel-offpeak-idle-plan
```

Both have their own fixed Endpoints, Access, and model members, and do not switch between each other at
execution time:

```text
Host / Scheduler
├─ prompt / mode
├─ idle ModelSelection
├─ Request Auth
├─ Off-Peak Ticket / attribution
└─ optional Subagent override = idle Selection
             |
             v
       Core Submission
             |
             v
   Registry / ModelFactory
             |
             v
      Idle Active Model
```

The Provider's Visibility, Access, Endpoint, models, and Model Config all come from normal Config/Rules. The
Host provides only the dynamic Request Auth, Ticket, and attribution for this valid dispatch, not complete
Provider/Model Config.

### Session State

The idle execution temporarily sets the Session Selection to the idle selection so its owning background
work can continue. The normal selection remains the persisted value and does not change App Recent,
Configured Default, or CLI Default.

```text
User Session = U → idle execution Session = I
                    ├─ whole item completes without takeover → restore U
                    └─ user message admitted → Session = user-submitted selection V
                                         └─ later restore/wake uses V
```

Idle sub-turns already started hold their own model and ticket until that turn ends. The old controller
keeps only idempotent receipts and does not overwrite later user selections.

### Busy and Queue

Idle dispatches are accepted only when the current Session can start-now. A busy race returns a typed
admission rejection, re-dispatched later by the Scheduler; Request Auth/Ticket does not enter the ordinary
Queue, Guide, held queue, or replayable pending input.

After a normal Submission sent by a running user is admitted by the CLI, it takes over the whole idle item
and enters the single CLI Queue. Queue items execute with their own saved Selection and do not inherit idle
Access, Ticket, or attribution; later background recovery/wake-ups read the latest user selection. A main
turn waiting for a new ticket resumes through the existing takeover path; sub-turns already started with a
still-valid old ticket may finish first.

### Automatic Compact

Idle Automatic Compact directly uses the Idle Active Model and the current valid Request Auth/Ticket; it
reads no Session Selection and accepts no Turn Runtime Model snapshot.

### Foreground Subagent

The general Subagent override for idle Submissions pins allowed Foreground Children to the idle Selection.
Each Child still creates its own Model through Registry/ModelFactory, using the current idle execution's
Request Auth/Ticket context. Explore, general-purpose, and custom Profile Provider/model overrides are all
overridden by this Core override for this round.

Background and Foreground Children can both start. They inherit the idle selection and their own independent
ticket leases; SendMessage and background Bash continue using ordinary tools and the notification mechanism.
As long as background work or pending notifications remain after the main turn ends, the whole item stays
resident.

### Permission / elicitation

D44 is maintained:

```text
Idle Turn
└─ permission / elicitation requested
       ├─ Normal Session displays and collects responses
       ├─ Off-Peak task remains running
       └─ approve / deny / skip
              └─ Same Turn continues, still using Idle Model
```

No `awaiting_approval` idle state is added; users are not switched to their Provider after approve; no
mid-turn Provider handoff exists.

### Tickets and Re-runs

When a ticket expires, executions already waiting for a renewal wait for the new ticket. The Scheduler hands
over the new ticket idempotently using executionId + renewalId + ticketId; the original task is not re-sent
and Bash is not re-run. Only model requests that have not yet delivered content may be retried. Ticket
release is separate from item completion: the item completes only when the main turn, background work,
pending notifications/input, ticket renewals, and model leases are all exhausted.

After user takeover, no further idle tickets are requested; started sub-turns holding a valid ticket may
end, and later turns use the user's selection. A restart does not restore background processes or
notifications. Tickets, queueing, and settlement belong to the Off-Peak domain and do not enter Registry.

## Independent Model Tasks

Title, Repo Wiki, Memory, WebFetch/WebSearch, and other one-off model tasks explicitly receive a
ModelSelection or Model, never reading the global mutable Runtime Model. They select by their own product
semantics:

- Belonging to the current Loop: use the current Active Model;
- Independent execution: create their own Model from explicit Selection;
- Subsequent wake main Loop: use the Session Selection at that time.

The default title freezes its owning execution and Selection at enqueue time and keeps its own idle ticket
lease independently until generation/saving completes or exits early or fails. An explicitly configured
title model runs under its own configuration; an external title without idle attribution does not borrow the
temporary idle Session Selection.

## Attribution

Usage, Trace, and errors for each ModelRequest are attributed to the actual `providerId + modelId`. Compact,
Subagent, Goal, Background, Off-Peak taskId, and request source are additional execution dimensions; they do
not replace Model identity. Already-issued requests cannot be retroactively attributed to a new Active
Model.

## Invariants

- A Loop has only one Active Model at any Model Step.
- Config/Composer changes do not hot-modify the Active Model.
- Guide switches atomically only at Step boundaries.
- Automatic Compact uses the current Active Model.
- Each Subagent creates its own Model.
- Goal/Background do not reverse-modify Session Selection.
- Idle selection is only staged in the Session; the normal selection is persisted, and after user takeover
  the old idle wrap-up does not overwrite it.
- After an idle permission response, the same Turn continues using the idle Model.
- Dynamic Request Auth/Ticket does not enter Config, Registry View, ordinary Queue, or persistence.
- Special executions create no temporary Providers, second Registry, or second Model type.
