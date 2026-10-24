# Session stop-source diagnostics

Todo103 G13-B; sources `8e3e10df4d`, `ee30f2ad33`.

## Contract

- The Composer stop button is marked `button`, and Esc on the currently focused Pane is marked `escape`.
- The existing `canStop`, dialog / consumed-Esc, read-only Pane and foreground execution ID guards are kept; no
  stop entry is added and the command protocol is unchanged.
- Both paths, command issued and skipped because nothing is stoppable, go through `logger.lifecycle.info`; a send
  failure goes through `logger.lifecycle.warn`. Ordinary `logger.info` is disabled in production builds and cannot
  carry mistaken-stop attribution.
- Only the source, Session ID and the already existing foreground execution ID are recorded; no prompt, model
  credential or message text. One stop operation logs once, not per streaming event.
- The log means "attempted to issue the command", not that the Agent accepted or terminated; final state is still
  owned by the original command ACK / Session projection.

```text
stop button / unconsumed Esc
             |
             v
existing Pane / canStop guard
   ├─ not stoppable -> skipped log, no command
   └─ stoppable -> source log -> original stop command (original execution ID)
                               └─ send failure -> lifecycle warning
```

## Verification

1. Mount SessionPane for real and click the Composer callback: the command still carries the projected execution
   ID and a button source is logged.
2. A non-stoppable Session: no stop command is sent and a skipped source is logged.
3. Logger production-branch test: lifecycle is forwarded through the desktop bridge, ordinary info is not; no
   desktop bridge does not throw.
4. The existing stop / queue E2E stays and is re-verified at final integration; this item changes neither the
   routing nor the state semantics of desktop continuous or mobile replayable.
