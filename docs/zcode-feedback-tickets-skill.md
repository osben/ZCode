# ZCode Feedback Tickets Skill Spec

## Goal

Add the workspace skill `zcode-feedback-tickets` so the Agent can safely query, read, update and close
out feedback tickets through the ZCode feedback-ticket Agent API.

## Source

The API contract comes from the Feishu document "ZCode Feedback Ticket Agent API Skill":
`https://internal-docs.example.invalid/redacted`

## Skill location

Project-level skill directory: `/.agents/skills/zcode-feedback-tickets`. A project-level rather than
global directory is chosen because the skill is bound to the ZCode feedback-ticket domain, status
transitions and project process, and should load with the z-code workspace.

## Trigger scope

Triggers when the user asks to handle ZCode feedback tickets, the feedback platform, ticket numbers
`ZCT-...`, read ticket context, download the data package, update ticket progress, resolve or transfer
a ticket, or batch archive/comment/reject/close.

## Key constraints

- Use `ZCODE_FEEDBACK_BASE_URL` by default; if unset, fall back to `https://feedback.example.invalid`.
- Admin API authentication uses `Authorization: Bearer $ZCODE_FEEDBACK_ADMIN_JWT`.
- If the token is absent, run the device authorization flow; never fabricate a token.
- Before a write, read the ticket context and confirm the ticket number, status and user intent.
- The dangerous `delete` operation runs only when the user explicitly asks.
- After a batch API returns, check `skipped`, not only `affected`.
- Use `已解决` (resolved) when development is done; do not use the old status `等待上线` (awaiting release).
- Do not leak the JWT, device code or sensitive attachment content in the final reply.

## Content layout

- `SKILL.md`: core flow, authentication prerequisites, safety boundary and the entry to common commands.
- `references/api.md`: API list, parameters, statuses and curl examples organized from the Feishu document.

## Verification

After creation run the skill validation script:

```bash
python3 /Users/dev/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/zcode-feedback-tickets
```
