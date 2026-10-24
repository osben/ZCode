# Plan Mode Plan File Compact Continuity

## Background

`ExitPlanMode` still carries the full plan in its tool input `plan` field. If compact triggers
soon after approval, the summary may not preserve the full plan and, after compact/resume, the
model cannot reliably get back the approved plan.

## Goal

After approval, `ExitPlanMode.plan` must be synchronously written to a deterministic plan file
under the workspace root. After a successful compact, the runtime must persist that plan file's
path and full content into the post-compact history as a `plan_file_reference` model-only
reminder.

## Path contract

```text
${workspaceRoot}/.zcode/plans/plan-${sanitizedSessionId}.md
```

`workspaceRoot` is the workspace root; never the `workingDirectory`, which Bash `cd` can change.
`sanitizedSessionId` keeps only `A-Z`, `a-z`, `0-9`, `.`, `_`, `-`, replaces everything else with
`-`, and strips leading/trailing `-`.

## Write contract

The plan file is written after user approval and after the final input from the permission broker
is applied. The content must be the final `plan` raw string — no trim, newline padding or other
normalization; an empty plan is only for input validation. The write uses
`FileSystemPort.writeTextFile()` with `createParents: true`, `atomic: true`, `encoding: "utf8"`.
A write failure affects only later compact continuity; it never blocks the already-approved plan
exit.

## Compact contract

After a successful compact, if the deterministic plan file exists and is non-empty, the runtime
appends to `postCompactReminderEntries` a model-only reminder with source `plan_file_reference`:

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

The reminder sorts before generic read-state reminders and persists together with the compact
summary via the existing `persistCompactSummary()`; on any persistence failure, the existing
compact persistence rollback applies.

## Non-goals

- No change to the provider-visible `ExitPlanMode` input schema.
- No runtime-injected `plan` / `planFilePath`.
- No change to the `ExitPlanMode` output shape.
- No new UI display.
- The plan file is not added to the generic read-state reminder.
- No recovery after the user manually deletes `.zcode/plans`.
- No default plan-file retention cleanup in this compact-continuity change; if implemented later,
  it must be driven by a retention-period config and clean expired `.md` files in the default plans
  directory — not immediate deletion at `ExitPlanMode`, compact or session end.
