# desktop-storage-sweep-gate

Main-process startup gate: only the first local Host in each app process gets `sweepAbandonedReservations` on its InitLocal. Every other local InitLocal waits until that first Host reports a startup phase past `preparing_host_storage` (`preparing_session_storage`, `starting_services`, `ready`) or `failed`, or its process exits. Rules and rationale are in `specs/first-submission-lifecycle.md`, "Placeholder startup sweep".

Invariants:

- `claim()` returns `sweepAbandonedReservations: true` only on the first call in each process; every later call returns false.
- A later ticket's `open` resolves only after the first ticket's `settle()`. `settle()` is idempotent; `settle()` on a non-first ticket is a no-op.
- Main claims right before posting InitLocal and registers the exit settle with the claim; a failed post settles too. A spawn that throws before the post leaves the gate unclaimed, so the next local Host carries the sweep.
- No timer (decided; rationale in the spec). A held window is shown the Host's sequence-0 `starting` state at once (`showHeldStartup` in `desktopHostProcess.ts`), so its renderer does not time out while it waits.
- The gate only delays sending InitLocal; it does not delay port creation or handing the port to the renderer.
- Wiring point: `spawnHostProcess` (`desktopHostProcess.ts`); when its `localHostStartupGate` is absent, nothing is gated.
