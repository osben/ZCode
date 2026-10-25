# Vercel React Best Practices Skill

## Background

The project-level Agent skills directory gains Vercel's official `react-best-practices` skill, used to
reference Vercel's performance rules when writing, reviewing or refactoring React / Next.js code.

## Source

- Repository: `vercel-labs/agent-skills`
- Path: `skills/react-best-practices`
- Skill name: `vercel-react-best-practices`

## Install location

Installed inside the project:

```text
.agents/skills/react-best-practices
```

This way the skill is version-managed with the project and does not depend on an individual developer's global `~/.codex/skills`.

## Usage boundary

- Applies to tasks on React components, Next.js pages, data fetching, bundle optimization, rendering performance and re-render optimization.
- When modifying `packages/ui` code, the UI, logging, i18n and multi-platform constraints of the root `DESIGN.md` and the current `AGENTS.md` still take priority.
- The skill only provides React / Next.js performance practice references and does not replace project-level constraints such as architecture boundaries, the remote-control chain and Workspace Identity.
