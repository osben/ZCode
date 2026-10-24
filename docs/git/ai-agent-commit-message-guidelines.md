# AI Agent Commit Message Specification

## Applicable Scope

This specification applies to all Git commit messages and PR titles generated or assisted by an AI agent in this project.

Goal: stay consistent with `Conventional Commits` and the semantic commit conventions in the Electron documentation, to cut history-tracing and release-distribution cost.

## Basic Format

The commit title (first line) must use semantic prefixes:

```text
<type>(<scope>): <subject>
```

Explanation:

- `<type>`: Commit type, required
- `<scope>`: Affected scope, recommended (e.g. `ui`, `services`, `agent`, `git`)
- `<subject>`: Brief description of the change result, using lowercase opening

Examples:

```text
fix(ui): avoid stale workspace path in git pane
feat(services): add provider config file resolver
docs(git): add ai agent commit message guidelines
```

## Type Conventions (Aligned with Electron Semantic Prefixes)

- `fix`: Bug fix
- `feat`: New feature
- `docs`: Documentation change
- `test`: Test supplement or correction
- `build`: Build system related change
- `ci`: CI configuration or script change
- `perf`: Performance optimization (no functional semantic change)
- `refactor`: Refactoring (no new functionality, no bug fix)
- `style`: Code style/formatting (does not affect code semantics)
- `chore`: Miscellaneous maintenance (dependencies, scaffolding, non-functional cleanups)

## Title and Body Rules

Following the Electron specification, a commit message satisfies:

1. The first line is at most 50 characters; never more than 72
2. An empty line after the first line
3. The body is wrapped at about 72 characters
4. The message explains **what was done and why**, not only which files changed

Recommended body structure:

```text
<type>(<scope>): <subject>

Why:
- Background / problem
- Trigger conditions or user impact

What:
- Key solution 1
- Key solution 2

Risk:
- Compatibility or regression risk
- Already done verification (typecheck/lint/test)
```

## AI Agent Specific Requirements

An AI agent follows these additional rules:

1. Do not write process noise: Do not write "according to the prompt modified", "according to conversation fixed", "AI auto-generated" in commit message
2. Do not write tool flow accounts: Do not list "what commands were run", unless it constitutes a change value (e.g. migration script)
3. A commit should express only one intention: Avoid mixing "refactoring + new feature + style adjustment" in a single commit
4. Bug fixes state the root cause and the fix strategy; keep non-obvious root causes consistent with code-internal Chinese comments, and do not add redundant comments for obvious modifications
5. PR title and final squash commit title must both use semantic prefixes

## Breaking Change Rules

When introducing incompatible changes, use in the body or footer:

```text
BREAKING CHANGE: <impact>
```

Examples:

```text
feat(agent): remove legacy provider handshake

BREAKING CHANGE: legacy agent providers before v2 can no longer connect.
```

## Unrecommended Writing Methods

Prohibited (they hurt history readability):

- `update code`
- `fix bug`
- `修改一下`
- `wip`
- `try fix`

## Pre-commit Checklist

Before creating a commit, the agent confirms:

- Commit title conforms to `Conventional Commits`
- Title and body can explain "why the change was made"
- Changed scope is consistent with `scope`
- The verification required by the applicable AGENTS.md has run: documentation follows document checks, code follows code checks, CLI/E2E follows its own scope verification
- When required verification is blocked or failed, keep the workspace changes and do not auto-commit; report failures and issues introduced by this change separately

## References

- [Conventional Commits](https://www.conventionalcommits.org/)
- Electron Commit Message Guidelines (`docs/electron/docs/development/pull-requests.md#commit-message-guidelines`)
- Project rules: [AGENTS.md](../../AGENTS.md)
