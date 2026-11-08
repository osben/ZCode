# external-sessions

Sessions recorded by other AI coding CLIs (Claude Code, Codex, OpenCode, Cursor, Gemini CLI) on this
machine, listed read-only for the Manage sessions settings section. Spec: `specs/external-sessions.md`.

- Public surface: `contract.ts` (browser-safe types, source catalog, resume-command helpers, the
  `IExternalSessionsService` descriptor on channel `external-sessions`) and `index.ts`
  (`createExternalSessionsService`, `createDefaultExternalSessionAdapters`).
- Owner of state: the service owns one in-memory listing cache per Host (TTL 15 s). Adapters are
  stateless readers; nothing is persisted and no ZCode store is written.
- Desktop local Host only: the service is registered by `createLocalServices`; web, web-remote
  attachments (mobile allowlist fails closed) and remote workspaces never see the channel.
- Invariants: tool stores are opened read-only; transcripts carry user/assistant text only and are
  capped; session ids reach a command line only when they match `EXTERNAL_SESSION_ID_PATTERN`;
  logs name sources, counts and paths, never titles or message text.
