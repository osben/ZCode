# Input prediction (ghost hint) on the Rust runtime

Status: implemented in `zcode-rs` (the v4 query `v4/conversation/inputPrediction`). Before: the method fell through to
`-32601`, so the Host answered `unavailable` for every request and the phone never showed a ghost hint.

This is not a composer feature and not a notification. It is a read-only request/response query that the phone's remote
control sends on demand, with or without a draft. Nothing is triggered at turn end. Product and wire rules:
`docs/web-remote-control/mobile-input-prediction.md`, `packages/shared/src/zcode-protocol-v4/input-prediction/contract.ts`.

## Node reference

- Handler: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/input-prediction-handler.ts` (class
  `ConversationInputPredictionHandler`, `collectInputPredictionTurns`, `createInputPredictionSessionLoader`), wired in
  `bootstrap/src/zcode-protocol/server.ts:365` and dispatched at `server.ts:702`.
- Prompt, parsing and decision: `apps/zcode-cli/packages/core/src/runtime/methods/input-prediction-sidecar.ts`.
- Model call: `app.generateWorkspaceText({selection, messages, querySource: "input_prediction"})`
  (`core/src/runtime/methods/workspace-generate-text.ts:155`): the session's current model selection, bound to the
  auxiliary options (lowest reasoning tier, output cap `min(5000, model max)`, `auxiliary-model-options.ts`).
- Host side: `packages/services/src/zcode-agent/zcodeAgentService.ts:7795` forwards exactly `{sessionId, revision, draft?,
requestId?}` and degrades every failure to `unavailable`. The on/off switch is the Host environment variable
  `ZCODE_REMOTE_INPUT_PREDICTION` (`inputPredictionSwitch.ts`), which also decides `hello.capabilities.inputPrediction`.
  Both live in the Host, so Rust needs no switch, no hello field and no `setting.json` key.
- Node's handler does not look at incognito or privacy profiles, and the workspace-scoped model path has none either.
  Rust adds no gate (nothing to port).

## Rules

1. Method `v4/conversation/inputPrediction`, params `{sessionId, revision, draft?, requestId?}`, strict: an unknown key,
   an empty `sessionId`, a negative or non-integer `revision`, a `draft` above 4000 UTF-16 units or a `requestId` outside
   1..128 units answers `-32602`.
2. The result is `{decision, candidates, topConfidence, requestId?}`; `requestId` is echoed when given. `decision` is
   one of `show`, `suppress_below_threshold`, `suppress_no_context`, `unavailable`, `cancelled`. Candidates are at most
   3, each `{text, confidence}`, `text` 1..40 UTF-16 units, one line, not blank, never trimmed at the start.
3. A blank draft (whitespace only) is no draft: the prediction is the user's next whole input, with the "next input"
   prompt. A non-empty draft uses the "completion" prompt and each candidate is the text that follows the draft.
4. Context is the session's real user turns: a turn is a `Human` user message (not a tool result, not meta, not a
   compact summary) paired with the last non-empty assistant text before the next real user message. Meta messages,
   attachments and tool results between them neither start nor end a turn. A real user message with no text is not a
   turn. Only the last 6 turns are used; the assistant text is cut at 800 UTF-16 units plus `…`; a turn without a reply
   reads `（无回复）`; the whole context is cut from its start to 6000 UTF-16 units.
5. Minimum turns before any model call: 2 without a draft, 1 with a draft; fewer answers `suppress_no_context`. A
   session that is not resident in this process (`server.bridge`, never opened cold) also answers `suppress_no_context`.
6. A session whose turns are enough but whose model cannot be called (no model port, the selection is not in the
   catalog, the call fails or runs past 20 s) answers `unavailable`. A failed transcript read answers `unavailable`.
   None of these is an error to the phone. `unavailable` is never cached.
7. The model call: one non-streaming side request on the session's current selection, system prompt and one user
   message as in Node (rule 3), reasoning level the first of the catalog entry, output budget `min(5000, model limit)`
   (5000 when the limit is unknown), `querySource` `input_prediction`, requester the session itself.
8. An unparseable reply answers `suppress_below_threshold`. Parsing strips `<think>` blocks (case-insensitive), a
   code fence, trailing commas and text around the outermost braces; entries need a string `text` and a numeric
   `confidence`; empty text drops the entry; no entry left is "unparseable".
9. Decision: each candidate becomes the text after the draft (single line, the repeated draft prefix removed, the end
   trimmed, the start trimmed only when the draft ends in whitespace, cut to 40 UTF-16 units without splitting a
   surrogate pair); blank ones are dropped; confidence is clamped to 0..1; a candidate whose `draft + text` equals one of
   the last 2 real user inputs (lowercased, all whitespace removed) is dropped; of equal texts the higher confidence
   stays; the rest sort by confidence, top 3. `show` when the top confidence is at least 0.8, else
   `suppress_below_threshold`.
10. One prediction per session at a time. A request for a session aborts the running one of that session; the aborted
    request answers `cancelled` (with its `requestId`) even if its model reply arrived. Other sessions are not touched.
    A cache hit does not abort anything.
11. Results of `show`, `suppress_*` are cached by `(sessionId, revision, normalized draft)`, 16 entries, least recently
    used out; a hit calls no model and carries the new request's `requestId`.
12. Logging: a degraded request logs one `warn` (`zcode_protocol.v4.input_prediction_transcript_failed` or
    `..._model_failed`) with the session id and the error text, never the draft or any conversation text. A superseded
    request logs nothing.
13. The model call has a 20 s limit. The wait ends at once when the request is aborted or the limit passes, whether or
    not the model port reacts to its cancellation token.

## State owner

`Handler` in `fork/input_prediction.rs`, one per `Server`: the in-flight table (session to generation and token) and the
LRU cache. Nothing else keeps prediction state. The session's messages and selection are read from the live session
(`SessionHandle::view`); no session fact, event or message is written.

## Interface

`fork/methods.rs` dispatches `v4/conversation/inputPrediction` to `Handler::handle`. The handler reaches the session and
the model through the `Backend` trait (production: the `Server`), so the tests script both.

## Acceptance

Rust unit tests in `fork/input_prediction_tests.rs` (crate `rust-cli-protocol-zcode`): the sidecar cases of `core/tests/input-prediction-sidecar.test.ts` (parse, suffix, decide, context and
prompts), the handler cases of `bootstrap/tests/input-prediction-handler.test.ts` (show and cache, same-session
replacement, other sessions, no context, unavailable and no cache, unparseable, strict params, abort and 20 s limit),
the turn pairing cases, and a model-port test that checks the request the model receives (source, reasoning tier, cap,
system prompt, session requester).

## Known differences

- Node appends a `ModelRequest` and a `ModelComplete` event and a usage fact to the session log for each prediction.
  Rust writes nothing, like `workspace/generateText` (`fork/workspace_model.rs`). The request still carries the
  `input_prediction` source in the usage headers.
- Node's `dispose` on connection close aborts in-flight predictions. Rust drops the request futures with the
  connection, so there is nothing left to abort and the tables die with the `Server`.
- Without a model port (an entry point with no model directory) Rust answers `unavailable` after the context checks.
