# Windows CIM Process Cleanup and Alert Noise Reduction Design

## Goal

On Windows 10 and later, remove the WMIC process-query backend and use PowerShell
`Get-CimInstance Win32_Process` uniformly. Narrow the Agent process cleanup error alert to the final retry
failure, reducing false `runtime process tree cleanup incomplete` alarms while keeping PID-reuse protection and
the fail-closed safety boundary.

## Non-goals

- No change to the two-phase `transport_ready` / `functional_ready` Helper startup protocol.
- Never call `taskkill /PID /T /F` on a bare PID alone. A managed `ChildProcess` root handle still held and
  confirmed alive by the Host is independent ownership evidence and is not treated as a bare PID.
- No Windows Job Object; that approach is designed separately.
- No larger Windows process cleanup deadline.

## Design

### CIM capability

The Local Host keeps PowerShell/CIM capability state for its lifetime. The first full CIM query confirms the
real capability and caches the result, with no extra probe process; the capability check must verify that
`powershell.exe` and `Get-CimInstance Win32_Process` are actually callable, not merely that the executable
exists.

Capability states distinguish at least:

- `cim`: the current Host can run CIM queries.
- `identity-unavailable`: PowerShell is missing, blocked by policy, or the query is unavailable this round.

A hard failure may be cached for the Host lifetime; a single timeout must not permanently poison later
cleanups and the next round may retry.

### Process snapshot and force verification

When Agent cleanup starts it runs one async full CIM query, indexes by PID, and stores `pid`, `parentPid` and
the normalized `CreationDate`. Descendants are derived only from this snapshot and the managed root lifecycle.

After the graceful-exit wait, the force phase still does a targeted CIM identity recheck of the known
root/descendants in the snapshot. A descendant may get `taskkill /PID /T /F` only when both PID and
CreationDate match; a query failure, timeout or identity mismatch stays fail-closed. The root has one bounded
exception: when cleanup has not entered `unverifiedRootOnly` and the original `ChildProcess` held by the Host
still has `exitCode/signalCode` both `null`, can send signals and the PID is confirmed alive, graceful `/T` or
the deadline `/T /F` fallback may be applied to that root only. The exception must not rediscover or claim
descendants via the root PID, nor add unverified descendants to the `/F` targets.

```text
Host init
  -> CIM capability (cached)
  -> cim / identity-unavailable

Agent spawn
  -> one full CIM snapshot
  -> PID index + parent links + CreationDate

cleanup
  -> EOF + graceful taskkill
  -> targeted CIM identity recheck
  -> exact match: taskkill /PID /T /F
  -> managed root handle still live: root-only /T /F fallback
  -> unavailable/mismatch descendant: no bare PID force, observe deadline
  -> unverifiedRootOnly: no handle fallback, observe deadline
```

### Alert policy

The first failure in `cleanupManagedProcessWithRetry` logs only a recoverable `warn` and keeps the original
error; if the retry succeeds the final cleanup counts as success with no error alert. Only when the retry also
fails is a single final `error` logged, with the final error kept as the return value.

## Acceptance

1. Code and tests no longer launch `wmic.exe`.
2. A missing WMIC no longer produces a `wmic.exe ENOENT` warning.
3. With PowerShell/CIM available, the full snapshot, targeted identity recheck and force behavior stay
   correct.
4. The `identityVerification: "unavailable"` / `unverifiedRootOnly` paths still fail closed and send no bare
   PID `/F`; the managed live root handle exception applies only to the root and must not spread to unverified
   descendants.
5. A first cleanup failure with a successful retry yields no final error; two failures yield exactly one final
   error.
6. Related Windows unit tests and Agent process manager unit tests pass.
7. Regression tests cover the managed root-only `/F` fallback when the targeted CIM recheck fails, and that no
   root `/F` is sent under `unverifiedRootOnly`.
