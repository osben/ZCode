# zcode-rs session and context gaps against Node

Small gaps found while closing the v4 rounds. Each item names the Node source, the Rust owner and the test. Node is the
oracle.

## 1. Legacy Gen UI tail in stored user messages

Node: `normalizeGenUiInput` (`apps/zcode-cli/packages/core/src/agent/message-history.ts`). Old App records spliced the
page state into the body as `\n\n<untrusted_gen_ui_state>\n{JSON}\n</untrusted_gen_ui_state>` at the very end. Node cuts
that tail where it builds rows and queue items, but only when the input's intent has no `genUiContext`, and only when
the JSON is a valid `genUiModelContextSchema` array. A tail that is not valid JSON, or whose entries break the schema,
stays in the text (a user's own example is not deleted). The regex is lazy and anchored at the end:
`/\n\n<untrusted_gen_ui_state>\n([^]*?)\n<\/untrusted_gen_ui_state>\s*$/u`.

Rust owner: `kernel-api/src/gen_ui_context.rs` `strip_legacy_tail` (the leftmost opening whose body fits before the
closing at the end; trailing white space is the JS `\s` set; the schema is the strict `{path, state}` entries, at most
100, then the path and size rules of `validate`). `protocol-zcode/src/projection/rows.rs` applies it to the text of a
stored human user message when its intent has no `genUiContext`, so a cold or live row shows the typed text.

Not changed: the model request. Node does not rewrite the stored body for the model either; the text the model read is
whatever was stored.

Tests: `kernel-api/src/gen_ui_context_tests.rs` (valid tail, trailing space, empty array, tail not at the end, broken
JSON, schema failures, two openings, no tail); `projection_tests.rs` `a_user_row_hides_the_legacy_gen_ui_tail`.

## 4. Off-peak tools per session

See `specs/fork-rust-automations.md` ("Registration per session"). The tools are no longer in the base registry; the
`OffPeakTools` layer (`tools/src/off_peak_tools.rs`, built in `runtime/src/assemble.rs` `query_parts`) offers them to a
session only while `OffPeakPort::tools_enabled(session)` holds. Test: `off_peak_tools_tests.rs`
`the_tools_are_offered_per_session`.

Not ported in this round, with the reason:

- 2. The `Execution worktree` system section. The session actor keeps only a boolean (`execution_worktree`). The
     sentence needs the parent workspace, the branch and the missing state at render time, and those are recorded at four
     places (create, prepared activation, cold open, forks and children). It needs a per-session registry like the
     incognito profiles plus a stat of the worktree root. Left for its own change.
- 3. `traceId`, `turnId` and `riskLevel` on tool hook input. Rust has no per-turn trace id on the hook path, and Node's
     `riskLevel` comes from each tool's metadata (PreToolUse) and from the permission decision (PermissionRequest), which
     Rust does not compute. It needs a product decision on the trace id and a table of risk levels.
