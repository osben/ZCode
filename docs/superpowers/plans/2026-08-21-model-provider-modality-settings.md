# Model Provider Modality Settings — Current Contract

Shipped (2026-08-21). Product boundary: `docs/superpowers/specs/2026-08-21-model-provider-modality-settings-design.md`.
Implementation: `packages/ui/src/settings/model-provider-section/` (dialog, draft helpers,
`ProviderModelModalityOptions.tsx`), `packages/shared/src/model-provider-types.ts`,
`packages/services/src/model-provider/modelProviderServiceStorage.ts`.

## UI semantics

- The model editor dialog shows all fields flat (no advanced collapse). Input modality choices
  (Text/Image/Video) are directly visible flat checkbox/pill options — no Popover. Output is fixed
  Text; Audio and PDF are not shown.
- Add-model draft defaults: context = 1M, maxOutput = 128K, input = Text, output = Text. Edit
  drafts echo the stored facts; legacy models without an explicit modality source keep the
  `unknown` source.
- Validation: id required; numeric fields positive integers; input Text is selected and cannot be
  deselected; output fixed Text. Cancel does not commit; save commits the complete model draft in
  one atomic write to the provider model config.
- Editing other fields (for example context/max tokens) must not touch the modality source.

## Persistence and projection

- OpenCode config persists `modalities` plus a `zcode` source marker; the round trip must not lose
  the source, and old configs without a source stay `undefined` (legacy unknown). Modifying only
  context/max tokens must not upgrade a legacy text-only model to explicit `[text]`.
- Protocol capability projection depends on the source, not on `modified`:
  legacy custom without explicit source → capabilities stay unknown (omit); explicit custom →
  `supportsImages`/`supportsPdf` derived from the selected inputs; catalog-backed → keep the
  current authoritative projection.
- Saving refreshes the active session registry without switching models: a revision update hitting
  the current model hot-updates `modelInputMediaCapabilities`; after switching to text-only,
  subsequent provider-visible request media is textualized while real session history is unchanged.

## Boundaries

- Desktop-attached remote (SSH/WSL/Docker): the local authoritative snapshot is pushed by
  `workspaceKey` + `remoteSessionId`; the remote never reads or writes its own provider config as
  authority.
- Web/mobile: settings UI stays responsive if reachable; task continuous/replayable, snapshot,
  queue and owner/lease carry no modality fields or behavior change. No platform APIs; only common
  Dialog interactions across Windows/macOS/Linux.

## Pruned cases (deliberate limitations)

- MOD-SET-006: audio/video input entering requests immediately — Video is stored as fact only,
  Audio is not shown; protocol/runtime do not support them yet.
- MOD-SET-007: non-Text output options and rendering — output is fixed Text.
- MOD-SET-008: mobile replayable restoring modality settings — app-global registry fact, never
  part of a task snapshot.
- MOD-SET-009: a pure non-text Agent model — input/output Text always exists.

## Risks (guarded by tests)

- Biggest risk: narrowing legacy `unknown` into explicit `false`; locked by absence-of-source tests.
- Second: a user edit of a built-in model blocking remote authoritative updates — the read-only
  boundary and `modified` merge rules must hold.
- Third: the UI implying audio/video are already usable by the Agent — scope copy or narrow the
  options instead.
- Rollback of the UI may stop writing the explicit source, but saved source fields must stay
  backward compatible (ignorable by old versions) and user `modalities` must never be deleted.
