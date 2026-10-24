# UI upstream sync fix ledger (G1: subagents, settings)

Scope: `packages/ui/test/subagentsSection.test.ts` (26 failing tests before the fix, 38/38 passing after).

- Root cause: `useWorkspaceServicesResolution` (integrated from fork) read the context through `useOptionalServices()` and threw when no ServiceProvider was mounted. The upstream test mocks `useOptionalServices` to `null` and `useServices` to the Subagent service context, matching upstream's `useServices()` read. Every SubagentsSection render through the config catalog resolution therefore threw "Workspace services are unavailable".
- Fix: the required hook now reads the context through `useServices()` (upstream contract, throws when no provider). The optional hook keeps `useOptionalServices()`. Both share one internal body, so resolution behavior is unchanged for real providers.
- File edited outside the G1 source hints: `packages/ui/src/hooks/useWorkspaceServices.tsx` (minimal: hook split only). Other groups touching this hook (G4 header, G5 project tree) should expect a rebase conflict on this region.
- Test-file note: `subagentsSection.test.ts` is the upstream `0a1fc56d` version (3-line diff). The fork version in `9c2434f7` has extra tests (edit-form sync from refreshed agents, mount-time thought-level replay, retired workspace catalog states) that upstream does not have; they were not ported, and reintroducing them would bring back fork-only useLayoutEffect and sync-state hacks that upstream replaced.
- Skipped tests (UI-2): none. Still failing in this file: none.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-fix-g1.md
