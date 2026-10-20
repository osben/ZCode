# Upstream bugfix port (3.16.1 audit): static path containment and terminal output buffering

## Scope

Two upstream v3.16.1 (`0a1fc56d`) bug fixes that the fork tree is missing. Only the affected hunks are ported; fork routes (`/api/connect-remote`, `/ws/remote/:id`, remote identity mapping) are unchanged.

## Owners

- Static file resolution: `packages/server/src/http.ts` (`resolveStaticFile`, `isInsideDirectory`, `isPathDriveQualified`). Single owner of static path containment.
- Terminal output emission: `packages/services/src/terminal/terminalService.ts` (`createBufferedTerminalOutputEmitter`). Single owner of PTY output fan-out per terminal instance.

## A. Static path containment (security)

- Behavior: a path whose decoded form starts with a drive letter (`Z:/x`, `Z:\x`, `Z:x`, including `%3A`) returns 404 and never reaches `path.resolve`. It does not enter SPA fallback.
- Behavior: `isInsideDirectory` treats an absolute `path.relative` result as outside the root. POSIX semantics are unchanged.
- Acceptance: drive-qualified requests return 404; `..` escapes fall back to the in-root SPA index; `packages/server/test/staticRoutePathContainment.test.ts` passes.

## B. Buffered terminal output

- Behavior: PTY output emitted before the first data listener subscribes is buffered (bounded at 1 MiB of characters, oldest chunks dropped first) and replayed in order when the first listener arrives.
- Behavior: output emitted while the listener set is empty after a disconnect is buffered the same way, so reconnects do not lose intermediate output. No timers are used.
- Behavior: fork terminal behavior (working directory selection per `specs/terminal-worktree-working-directory.md`) is unchanged.
- Acceptance: a chunk pushed before subscription is delivered on subscription; ordering is preserved; the buffer cap drops the oldest chunks; a listener attached after removal receives output buffered while detached; `packages/services/test/terminalOutputBuffer.test.ts` passes.
