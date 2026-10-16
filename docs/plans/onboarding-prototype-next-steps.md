# Next Steps for the Onboarding Prototype

Recorded: 2026-09-15. Branch: `prototype/onboarding-suggestions`.

## Confirmed Requirements

- Integrate the existing data-migration stage into the new onboarding flow so users are not shown two consecutive onboarding sequences.
- Keep the current three steps: work direction → UI mode → assistant preferences.
- Connect the UI mode to the general/coding modes already merged into staging; use the Settings terminology for workspace memory.
- This is still an iterative prototype. This document records requirements and recommendations; it does not mean that migration interactions have been implemented or fully approved.

## Facts About the Current Implementation

After `OccupationOnboarding` completes, the old `OnboardingDialog` is rendered. The legacy migration choices are ordered as: sessions → Skills → MCP servers → commands → AGENTS.md → migration execution/results. The plugin and proxy-settings steps are temporarily hidden.

The session source is native Claude Code history; the other import categories use the external-Agent resource-import capability. The AGENTS.md step copies the user's Claude-level `CLAUDE.md` to the ZCode user-level `AGENTS.md`; require explicit confirmation before overwriting.

## Proposed Interaction (Pending Confirmation)

Keep the three-step preference progress indicator and make migration an optional branch after onboarding, rather than expanding five technical categories into five mandatory first-run steps.

```text
Sign in / Sign up (previously suggested order; product confirmation pending)
  → Work direction → UI mode → Assistant preferences
  → Ready: Start using ZCode (primary) / Import existing data (secondary)
      ├─ Start using ZCode → Workspace
      └─ Import existing data → Select items → Confirm and import → Results → Workspace
```

- Reuse the current visual design on the ready page and remove the duplicate introduction from the old welcome page. Explain: “Used tools like Claude Code? Import your existing sessions and configuration, or import them later in Settings.”
- Do not start migration without user choice. Scan on demand after entering the import branch, distinguishing scanning, no items found, and scan failure.
- Show the five categories—sessions, Skills, MCP, commands, and user instructions—together on the selection page. After expanding a category, let users select sources and individual items while retaining the existing target, import-method, and scope controls. When there is no workspace, clearly state that project-level imports require selecting a project first.
- Allow imports in general mode; do not hide capabilities based on occupation or mode. Use accessible labels such as “Conversation history” and “Custom instructions,” retaining technical names as supporting information.
- Provide Back and Confirm and import actions. Preserve selections when navigating back. Preview the actual import target, conflicts, and overwrite behavior. Keep the existing explicit confirmation before overwriting AGENTS.md.
- Show real progress on the execution page. On the completion page, distinguish successful, skipped, and failed items and provide an entry point to the workspace. Reuse the existing confirmation when exiting during an active operation. Confirm background migration and retry capabilities separately; do not promise them in advance.
- Do not show this flow again to existing users, users who have completed preferences, or users who have skipped migration. Keep a manual entry point to migration in Settings.

## Follow-up Implementation Checklist

- [ ] Confirm the ready page and optional import branch, including where sign-in belongs.
- [ ] Replace the chained old/new onboarding entry points with one flow and remove the duplicate welcome step.
- [ ] Define separate persistence boundaries for preferences completed and migration not selected/skipped/completed; do not let a single flag control every flow.
- [ ] Reuse the migration service and import controls, with consistent layout and scanning/empty/error/execution/result states.
- [ ] Preserve overwrite confirmation, source-data protection, existing import scopes, and deduplication rules.
- [ ] Align desktop, remote workspace, and mobile capabilities; preserve shared-host, `workspaceIdentity`, and continuous/replayable boundaries.
- [ ] Add tests, a formal spec, and release preparation after the prototype is approved.

References: `docs/ui/onboarding-migration-flow.md` and `docs/onboarding-external-agent-import-steps.md`. Actual capabilities are determined by the current implementation.
