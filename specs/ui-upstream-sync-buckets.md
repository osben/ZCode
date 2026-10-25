# UI upstream sync: typecheck buckets after overlay

Snapshot of `pnpm typecheck` right after the 3.16.1 overlay: exit 2, 513 errors (503 in
packages/ui, 10 in packages/web, out of scope). The three buckets drove the port work:

- Stale fork-edited files still present (upstream deleted): 15 files. Removed after ledgering.
- Fork-only files (not upstream, not deleted upstream) with errors: 38 files. Fork features to
  re-port.
- Upstream-owned files with errors (missing services/shared exports, moved modules): 93 files.

Outcome: the per-file bucket lists were the port worklists; the authoritative final state of each
file is `specs/upstream-sync-final-ledger.md`, with per-bucket detail in
`specs/ui-upstream-sync-ledger-b*.md` and `specs/ui-upstream-sync-ledger-2*.md`. The row kept open
here is the rule violation below.

## Upstream-owned window.zcode users (rule violation, taken as-is, fix later)

- `packages/ui/src/browser-use/useDesktopZoomFactor.ts`
- `packages/ui/src/hooks/index.ts`
- `packages/ui/src/hooks/usePlatform.tsx`
- `packages/ui/src/logger.ts`
- `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx`
- `packages/ui/src/settings/CodingPlanUpgradeDialog.tsx`
- `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx`
- `packages/ui/test/rewardsBridge.test.ts`
- `packages/ui/test/workspaceFileSearchSection.test.ts`

Full history: git show 127b9c78:specs/ui-upstream-sync-buckets.md
