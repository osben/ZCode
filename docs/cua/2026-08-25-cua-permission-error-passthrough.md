# CUA Permission Error Passthrough and Recovery Contract

- Date: 2026-08-25
- Status: implemented, pending MR review
- Related: producer `zcode-cua` !576, consumer `z-code` !2315

## Decision

ZCode no longer consumes or produces `CUA_PERMISSION_REQUIRED`. CUA Helper/Broker failures enter the model and ToolCallRow as ordinary MCP tool errors; the model reads the exact error and decides whether to call the read-only `request_access`, re-activate the app or re-observe. An ordinary error itself has no UI side effect; only a live `request_access` structured permission snapshot that passed official-CUA authority validation may trigger the separate Host confirmation flow.

## Root cause of the old behavior

```text
permission_denied
  -> producer guesses macOS TCC
  -> MCP structuredContent flattened into text
  -> Renderer includes("CUA_PERMISSION_REQUIRED")
  -> automatically requests Accessibility + Screen Recording
```

`permission_denied` carries TCC, foreground policy, Windows UIPI, Linux input, invalid native capability and other failures. Refining further across layers and re-checking adds a new state machine and still cannot prove a real permission gap from a generic error code, so deleting the automatic classification is more reliable than narrowing it.

## New chain

```text
Helper/Broker original error
        |
        v
ordinary MCP error + original message + delivery evidence
        |
        +--> ordinary ToolCallRow / continuous / cold replay
        |
        v
model chooses request_access / activate / re-observe / stop

official live request_access typed metadata
        |
        v
desktop-continuous local Host rechecks fresh status
        |
        v
ZCode confirmation -> existing permission onboarding
```

## Invariants

- The producer does not return `CUA_PERMISSION_REQUIRED` and the consumer does not scan that string.
- The Renderer never opens a confirmation dialog, system settings or permission onboarding automatically because of a tool error.
- The settings page and Composer status entries remain. In addition, on local macOS `desktop-continuous` the official `request_access` live result may show a ZCode confirmation dialog first when permission is clearly missing; system settings are never opened before user confirmation.
- `request_access` stays read-only: no system permission prompt, no new Helper.
- Text parsing of `request_access` serves only Tool Card display and must never be a behavior trigger. The trigger must come from producer namespaced `_meta`, official authority and a strict runtime schema.
- With `action_sent=true` or `request_delivery_state=possibly_sent` the original action is never replayed automatically.
- `broker_unavailable` keeps using `CUA_NOT_READY` because it expresses transport readiness and retry safety, not permission inference.
- Desktop continuous and mobile replayable show the same ordinary failure facts; live permission observation exists only on local desktop continuous, and mobile neither receives that event nor starts an independent Helper.
- Old strings in historical transcripts are displayed as plain text and cannot retrigger side effects.
- After authorization returns, only the Helper is restored and permission refreshed; no task command, continuation or automatic tool replay is sent.

## Coverage

- producer unit + stdio MCP: TCC-shaped and non-TCC `permission_denied` both return as is.
- producer fault: `possibly_sent` is preserved and dispatch is not repeated.
- consumer unit: Root/ToolCallRow mounts no permission gate; old error text has no side effect.
- consumer live observation: only legitimate official `request_access` metadata triggers; same-named third-party tools, malformed metadata, snapshot/recovery/mobile/remote have no side effect.
- conversation replay: the failed ToolCallRow, subsequent assistant content and cold restore are consistent.
- package: a new package with the same semver but a different buildId replaces the old Helper.
- real model: all use Kimi K3, with the application's final state verified by an independent oracle.

Deterministic replay artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20260824-194204-941`. It shows that an ordinary MCP error containing the historical `CUA_PERMISSION_REQUIRED` text produces exactly one failed tool row, live and cold restore agree, and no automatic permission dialog appears; it does not replace the Kimi K3 real-model gate.
