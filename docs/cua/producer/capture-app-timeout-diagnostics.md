# capture_app timeout diagnostics contract

## Background

macOS `capture_app` walks the target window's Accessibility tree in a Helper async worker. When the target
app is briefly unresponsive, the AX tree is huge or the worker queues, the call is cut by an 8-second
wall-clock fence. The error used to say only "exceeded the 8 second wall-clock deadline", so it was
impossible to tell whether it stalled in window resolution, first AX warm-up, the window tree, the menu
tree or a specific AX attribute read.

## Goals

- On timeout, the MCP error carries the most recent structured diagnostic so the model I/O trace is
  directly usable as evidence.
- The Helper also writes the same diagnostic to the controlled `--exit-log`, covering product launches
  where LaunchServices discards stderr.
- Native diagnostics record only phase, last AX operation, node count, elapsed time, PID and window id;
  never control text, clipboard, tokens, sockets, window titles or other user content.
- A normal fast capture writes no log; one line is written only on timeout, so log volume does not scale
  with message traffic.

## Diagnostic fields

`captureAppDiagnostic(pid, windowId?)` is an additive native ABI that returns, for the latest matching
capture:

- `phase`: current/final phase, for example `capture_lock`, `window_resolve`, `tree_traversal`,
  `menu_traversal`, `native_complete`.
- `last_ax_operation`: the operation name recorded before entering the AX API that may block.
- `nodes_visited`: number of AX nodes whose read has started.
- `elapsed_ms`: monotonic-clock time since N-API admission, including libuv queueing.
- `deadline_exceeded`: whether the native absolute deadline had been passed when the diagnostic was read.
- `pid` / `window_id`: only bind the diagnostic to this request; no authorization material.

If the diagnostic ABI is missing, returns an invalid shape or throws, the original timeout error must
still return normally; the diagnostic path must not change `capture_app` failure semantics.

## Log location

Both the ZCode product and standalone launches pass `--exit-log <socket>.exit.log` to the Helper. On
timeout the Helper appends one line `[capture-app-timeout] ...`; the original error text carries the same
field summary, so the model trace keeps the diagnostic even if the log file is cleaned up.
