# AI Agent Commit Message Specification

## Applicable Scope

This specification applies to all Git commit messages (commit message) and PR titles generated or assisted by AI Agent in this project.

The goal is to maintain consistency with `Conventional Commits` and reference the semantic commit conventions in Electron documentation, reducing historical tracing and release distribution costs.

## Basic Format

The commit title (first line) must use semantic prefixes:

```text
<type>(<scope>): <subject>
```

Explanation:

- `<type>`: Commit type, required
- `<scope>`: Affected scope, recommended to write (e.g. `ui`, `services`, `agent`, `git`)
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

Referencing Electron specifications, commit information should satisfy:

1. The first line should be kept within 50 characters maximum, longest not exceeding 72 characters
2. An empty line after the first line
3. The body should be wrapped approximately every 72 characters
4. The commit message description should explain **what was done + why**, not just "which files were changed"

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

To ensure commit history maintainability, AI Agent must follow additional rules:

1. Do not write process noise: Do not write "according to the prompt modified", "according to conversation fixed", "AI auto-generated" in commit message
2. Do not write tool flow accounts: Do not list "what commands were run", unless it constitutes a change value (e.g. migration script)
3. A commit should express only one intention: Avoid mixing "refactoring + new feature + style adjustment" in a single commit
4. Bug fixes must write clear root cause and fix strategy; keep non-obvious root causes consistent with code-internal Chinese comments, do not add redundant comments for obvious modifications

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

The following methods reduce historical readability and are prohibited:

- `update code`
- `fix bug`
- `修改一下`
- `wip`
- `try fix`

## Pre-commit Checklist

Before creating a commit, AI Agent must confirm:

- Commit title conforms to `Conventional Commits`
- Title and body can explain "why the change was made"
- Changed scope is consistent with `scope`
- Necessary verification has been performed as specified in applicable AGENTS.md for this change; pure documentation follows document checks, code follows code checks, CLI/E2E follows its own scope verification
- When necessary verification is blocked or failed, keep workspace changes, do not auto-commit; report separately any failures and issues introduced in this change

## References

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Electron Commit Message Guidelines](../electron/docs/development/pull-requests.md#commit-message-guidelines)
- Project rules: [AGENTS.md](../../AGENTS.md)
