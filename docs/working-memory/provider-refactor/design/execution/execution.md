# Model Execution and Inheritance

This document specifies how various executions obtain, maintain, or switch Models after a Submission enters Core. Selection state is documented in
[`../interaction/interaction.md`](../interaction/interaction.md), Model creation and auth is documented in
[`../registry/model-creation.md`](../registry/model-creation.md).

## General Principles

1. A single execution first determines ModelSelection, then creates a Model from Registry/ModelFactory.
2. Each Agent Loop holds its own Active Model.
3. The Active Model is immutable after creation, until the Loop ends or Guide switches at an explicit Step boundary.
4. Automatic Compact uses the current Loop's Active Model.
5. Subagents create their own Models based on the final Selection.
6. Background/Goal new main Loops use the Session Selection determined at startup.
7. Special executions only attach Request Auth, Ticket, attribution, or override; they do not carry Provider/Model static Config.

## Execution Categories

| Execution               | Selection Source                              | Model Lifecycle                  | Session Selection                 |
| ----------------------- | --------------------------------------------- | -------------------------------- | --------------------------------- |
| Normal start-now        | Current Submission                            | New Agent Loop                   | Updated on receipt                |
| Normal Queue drain      | Submission saved in Queue item                | New Agent Loop                   | Updated when dequeued and started |
| Guide / "Immediate"     | Guide Submission                              | Subsequent Steps in current Loop | Updated when Guide is received    |
| Automatic Compact       | Current Loop Active Model                     | Current Loop                     | Not updated                       |
| Manual Compact          | Compact Submission                            | New Loop                         | Normal rules                      |
| Subagent                | override > Profile > Parent Selection         | Child lifecycle                  | Does not update parent Session    |
| Background              | Selection determined at startup               | Background lifecycle             | Does not update back              |
| Goal continuation       | Session Selection at the time of continuation | New main Loop per round          | No extra save                     |
| Off-Peak automatic turn | ModelSelection from idle Submission           | Current automatic Loop           | Not updated                       |

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

Composer switching, normal Session config changes, or Registry refresh do not change the current Active Model. New configurations are read only when creating the next Model.

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

Already-issued requests continue using A; subsequent Steps and subsequent Automatic Compact use B. Context injection, Session Selection update, and Active Model switching form a single atomic receipt result; if any step fails, the complete Guide falls into the ordinary Queue, not just a partial submission.

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

It does not read Composer or Session Selection, does not establish another set of Provider/Capability DTO. After a Guide switch, subsequent Automatic Compact uses the new Active Model.

### Manual Compact

Manual Compact is a new Submission/Loop, creating a Model based on its own Selection. It does not inherit the temporary execution context of the ended Loop.

## Subagent

Subagent Selection priority is fixed:

```text
Core Server Submission override
        >
Subagent Profile Selection
        >
Parent Loop Active Selection
```

After determining Selection, the Child creates its own Model from Registry:

```text
Final Child Selection
        |
        v
Registry / ModelFactory
        |
        v
Child-owned Active Model
```

Fresh/Fork defines Context initialization, Foreground/Background defines scheduling; none of these change the model inheritance rules. Core Server override is a general execution option that can require all Children derived from this Submission to use a specified Selection; it is not an idle-task-only field, nor does it enter the Agent tool's provider-visible input.

Normal Profile explicit models and reasoning continue to be parsed according to Subagent settings semantics. When a Profile lacks a model, it inherits the Parent's Active Selection; Children do not share the same mutable Model object as the Parent.

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

Goals do not save extra continuation Selections. New Loops use the Session Selection at the time of re-run, and create new Models through Registry.

## Background

Background creates its own Model at startup, and maintains it for its own lifecycle:

```text
Turn 1: Selection A, starts Background A
Turn 2: User Submission uses Selection B
Background A completes
Turn 3: Wake main Agent, read Session Selection B
```

Background continues using A; after completion, it only triggers a new main Loop. The Background Model does not reverse-modify the Session Selection.

## Idle Tasks

Idle tasks use user-invisible but complete Built-in Providers based on the current account Family:

```text
Z.ai      -> account:zai-offpeak-idle-plan
BigModel  -> account:bigmodel-offpeak-idle-plan
```

These two Providers have their own fixed Endpoints, Access, and model members, and do not switch between each other at execution time:

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

The Provider's Visibility, Access, Endpoint, models, and Model Config all come from normal Config/Rules. The Host only provides the dynamic Request Auth, Ticket, and attribution for this valid dispatch, not the complete Provider/Model Config.

### Session State

Idle tasks do not modify and restore the user's Session Selection:

```text
Session Selection = U

Idle Loop starts
├─ Session Selection = U
└─ Active Model = I

Idle Loop terminal
├─ Model I ends
└─ Session Selection = U

Next user Submission
└─ Registry creates Model based on U
```

There is no `previousModel`, temporary `setModel`, or restore `finally`.

### Busy and Queue

Idle dispatches only accept when the current Session can start-now. A busy race returns a typed admission rejection, which is re-dispatched by the Scheduler later; Request Auth/Ticket does not enter the ordinary Queue, Guide, held queue, or replayable pending input.

Normal Submissions dispatched by running users enter the unique CLI Queue. After the Idle Turn terminal, queue items execute using their own saved Selection/Session normal semantics, inheriting no idle Access, Ticket, or attribution.

### Automatic Compact

Idle Automatic Compact directly uses the Idle Active Model and the current valid Request Auth/Ticket; it does not read Session Selection, nor accepts a Turn Runtime Model snapshot.

### Foreground Subagent

The general Subagent override for idle Submissions pins allowed Foreground Children to idle Selection. Each Child still creates its own Model through Registry/ModelFactory, using the current idle execution's Request Auth/Ticket context. Explore, general-purpose, and custom Profile Provider/model overrides in these are all overridden by this Core override for this round.

Background Children fail-closed by Tool Policy before making model requests. This prohibition is an idle scheduling strategy; it is not written into Provider Config or Registry.

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

No `awaiting_approval` idle state is added; users are not switched to their Provider after approve; no mid-turn Provider handoff is established.

### Tickets and Re-runs

Ticket expiration, cancellation, failure, success, or process restart ends the current valid execution context. The Scheduler retains the Task, Session, and transcript; after obtaining a new Ticket, it sends a new idle Submission and creates a new Idle Model. Ticket queuing, 3-hour timebox, continuation, and settle belong to the Off-Peak domain and do not enter Registry.

## Independent Model Tasks

Title, Repo Wiki, Memory, WebFetch/WebSearch, and other one-off model tasks should all explicitly receive a ModelSelection or Model, never reading the global mutable Runtime Model. They select based on their own product semantics:

- Belonging to the current Loop: use the current Active Model;
- Independent execution: create their own Model from explicit Selection;
- Subsequent wake main Loop: use the Session Selection at that time.

## Attribution

Usage, Trace, and errors for each ModelRequest are attributed to the actual `providerId + modelId`. Compact, Subagent, Goal, Background, Off-Peak taskId, and request source are additional execution dimensions; they do not replace Model identity. Already-issued requests cannot be retroactively attributed to a new Active Model.

## Invariants

- A Loop has only one Active Model at any Model Step.
- Config/Composer changes do not hot-modify the Active Model.
- Guide switches atomically only at Step boundaries.
- Automatic Compact uses the current Active Model.
- Each Subagent creates its own Model.
- Goal/Background do not reverse-modify Session Selection.
- Idle tasks do not modify and then restore Session Selection.
- The same Turn continues using the idle Model after an idle permission response.
- Dynamic Request Auth/Ticket does not enter Config, Registry View, ordinary Queue, or persistence.
- Special executions do not create temporary Providers, a second Registry, or a second Model type.
