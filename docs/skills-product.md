# Skills Product Specification (Inspired by z-work)

## 1. Purpose

This document defines the product design for the `Skills` capability in ZCode. The goal is to reuse and localize the validated skill system from the related `z-work` project, producing a practical, operable, and extensible skills product.

## 2. Background and Problems

The Agent already has many capabilities for complex tasks, but three core problems remain:

- Capabilities are scattered: users do not know what the Agent can do.
- Experience is not reusable: team workflows are difficult to preserve as callable capabilities.
- Context is congested: injecting all instructions at once increases token cost and reduces reliability.

The core value of `Skills` is to package “expertise + workflow + resources” into discoverable capability units that can be activated as needed, reducing prompt overhead and improving task completion and consistency.

## 3. Product Goals

- Establish a unified mechanism for discovering and activating skills, with on-demand loading.
- Support personal and team skills together, with clear precedence.
- Allow skills to include scripts, templates, and reference materials to form complete workflows.
- Provide low-friction UI entry points (such as `$` in the input box) and a management panel.
- Ensure activation is auditable, permissioned, and reversible.

## 4. Non-goals for This Phase

- No cross-platform online skills marketplace in v1.
- No complex billing system in v1.
- No automatic execution of high-risk external actions in v1; user confirmation remains the default.

## 5. Target Users and Core Scenarios

- **Individual developers:** install and reuse skills such as “code review,” “document generation,” and “release checks.”
- **Engineering teams:** preserve team SOPs in a shared skills directory.
- **Platform maintainers:** use skills governance (enable/disable/version) to control quality and risk.

Typical scenarios:

- A new team member uses skills to follow standard workflows after joining a repository.
- Users call an existing skill template for a repeated task.
- The Agent identifies and activates a matching skill during a complex, multi-step task.

## 6. Terminology

- **Skill:** a directory centered on `SKILL.md` that contains metadata, execution instructions, and optional resources.
- **Skill Catalog:** the list of skills visible to the current session.
- **Skill Activation:** the process of moving from “visible” to “loaded and executable.”
- **Skill Scope:** where a skill applies: workspace or user.

## 7. Information Architecture and Directory Conventions

Following z-work, use these directory conventions:

- `workspace skills`: `<repo>/.agents/skills/` (including compatible alias directories)
- `user skills`: `~/.agents/skills/`
- `extension skills`: bundled with extensions in a future version

Recommended structure for each skill:

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` is required and must include at least:

- `name`: unique skill identifier, preferably matching the directory name.
- `description`: trigger scenarios and capability description, used for discovery and matching.
- `body`: execution rules, workflow, and boundaries applied after activation.

## 8. Skill Discovery and Precedence

At session startup, the system loads only lightweight metadata (`name` and `description`), not the full body.

Discovery precedence:

1. Workspace
2. User
3. Extension

A skill with the same name at a higher precedence overrides the lower-precedence skill, allowing team rules to override personal defaults.

## 9. Activation Mechanism (Core Flow)

1. The user starts a task.
2. The Agent matches the task's meaning against skill descriptions.
3. On a match, the Agent requests activation and displays the skill name, purpose, path, and permission scope.
4. After user confirmation, load the `SKILL.md` body and directory resources.
5. The skill becomes active for the session, and its workflow takes precedence during execution.
6. Activation ends with the session; activate again on demand in the next session.

Design principles:

- **Progressive disclosure:** metadata first, then the full body.
- **Explicit authorization:** ask the user to confirm before activation.
- **Least privilege:** grant access only to the skill directory's required scope.

## 10. Interaction Design (MVP)

### 10.1 Input Entry Point

Keep a skills entry hint in the chat input (for example, `$ for skills` / `$`), reducing the learning curve.

### 10.2 Skills Panel

Provide a `Skills` panel that supports at least:

- Browsing a list (name, description, source, and status).
- Enabling/disabling skills.
- Switching scope (workspace / user).
- Manually refreshing discovery results.

### 10.3 Command Entry Point (Optional)

Keep command-based management (inspired by z-work's `/skills` interaction) for advanced users performing bulk operations.

## 11. Security and Governance

- Activation audit: record skill name, source, activation time, and initiating task.
- Risk isolation: require a second confirmation for high-risk skills.
- Version governance: when a same-name skill overrides another, display source and version information.
- Fallback: if activation fails, fall back to running without the skill so the task can continue.

## 12. Success Metrics

After launch, focus on:

- `Skill activation rate`: share of tasks involving a skill.
- `Skill task success rate`: one-pass completion rate after activating a skill.
- `Average execution time`: whether time for similar tasks decreases.
- `Reduction in repeated operations`: decrease in manual steps for standard workflows.
- `User satisfaction`: feedback on skill usability and controllability.

## 13. Suggested Milestones

- **M1 (Core capability):** directory discovery, metadata injection, manual activation.
- **M2 (Manageability):** list page, enable/disable, scope management.
- **M3 (Intelligence):** automatic matching and activation, activation audit, risk levels.
- **M4 (Ecosystem):** extension sources, import/export, and a marketplace for team templates.

## 14. Open Questions

- Should conflicts support a merge strategy instead of simple override?
- Should skill status be isolated and displayed per session when sessions run concurrently?
- How should skill-directory synchronization and permissions work in remote mode?
- Should skill execution results be evaluated and ranked automatically?
