# Voice Dictation v2

Evolution of the fork's local voice dictation after upstream 3.18.x introduced its own
(server-ASR based) voice input. The fork keeps local models as the primary engine and
adopts upstream's stronger UI/UX patterns where they win. This spec covers the roadmap;
Track A is fully specified, Tracks B–F are scoped summaries to be detailed before
implementation.

## Background

- Fork dictation: `packages/services/src/voice-dictation/` (local GGUF models via
  transcribe-cpp/koffi, streaming + one-shot, post-processing, push-to-talk) plus the
  Web Speech engine for web remote (`useWebSpeechDictation`).
- Upstream 3.18.x added `voice-input`: cloud ASR through zcode-server (zh-CN/en-US only,
  login-gated), capsule waveform UI, in-editor "voice text" span, main-process
  microphone permission flows. See upstream `docs/chat/composer-voice-input.md`.
- Model data source: `cjpais/Handy` `src-tauri/src/catalog/catalog.json` (MIT). The fork
  catalog was generated from an early snapshot (13 models); Handy now publishes 73 ASR
  models with per-quantization files, capabilities, `minEngine`, and a `curated` flag.

## Decisions (agreed with the owner)

1. Quantization selection is in scope: descriptors carry all published quantizations,
   the user picks one per model (default `Q8_0` as published by Handy).
2. Catalog scope: every Handy model with `role: "asr"` (73), not a curated subset.
   Licenses (including non-commercial ones) are displayed as-is.
3. The voice-span editor semantics (Track C) land before the next upstream sync, so
   upstream's implementation is reconciled against ours.

## Track A — Catalog refresh from Handy (this change)

### A1. Converter script

`scripts/sync-voice-model-catalog.mjs` regenerates
`packages/services/src/voice-dictation/voiceModelCatalog.ts` from Handy's catalog
(URL or local path argument). Properties:

- Filters `role === "asr"` entries.
- Field mapping: `id, name, description, family, license, revision`, `repository` →
  `huggingFaceRepo`, `quant` → `defaultQuant`, `minEngine`, `parameters`,
  `capabilities.streaming` → `streaming`, `curated`, `files` → `quants`
  (`{fileName, sizeBytes, sha256}` per quantization).
- Locale-form language lists (only `nemotron-3.5-asr-streaming-0.6b` today) become
  bare `languages` plus the `languageLocales` map, preserving the existing convention.
- Missing `description` stays empty string; the UI renders no description line then.
- Fork-only `recommendRank` values are applied from an override map in the script
  (the five existing ranks). Ranks are not re-tuned here.
- Identical language sets are deduplicated into named constants
  (`LANGUAGE_SET_1..N` with a user-list comment) inside the generated file.
  `voiceModelLanguageCodes.ts` is removed (only the generated catalog used it).
- The generated header records the source repo, the catalog's `transcribeCpp`
  target, and the generation command. The file is committed; the script exists for
  future refreshes and is covered by a fixture test.

### A2. Descriptor and store changes

- `VoiceModelDescriptor` replaces the single `fileName/sizeBytes/sha256` with
  `quants: Record<quant, {fileName, sizeBytes, sha256}>` plus `defaultQuant`.
- `VoiceModelStore`: `getState(id, quant?)`, `getReadyModelPath(id, quant?)`,
  `download(id, quant?)`, `cancelDownload(id, quant?)`. In-flight downloads are keyed
  by `id:quant`. `remove(id)` still removes the whole model directory (all quants).
- `VoiceModelListItem.state` becomes `states: Record<quant, VoiceModelState>` so the
  UI can show per-quant download state. Filters treat "downloaded" as any quant
  ready and "downloading" as any quant downloading.
- Service requests (`transcribe`, `beginStream`, `warmUp`, `downloadModel`,
  `cancelDownload`) accept an optional `quant`, defaulting to the descriptor's
  `defaultQuant`.

### A3. Settings

- `voiceDictation.quantByModel?: Record<modelId, quant>` (fork sidecar settings, same
  storage rules as the rest of `voiceDictation`). The composer and settings pass the
  selected quant to the Host; changing a model's quant re-downloads that quant file
  when used.

### A4. Settings UI

- Model row gains a quantization select (options from `descriptor.quants` with sizes,
  ready quants marked); the standalone size chip renders only when the picker is absent, so the
  size never shows twice. Download/cancel/use act on the selected quant.
- Badges: `curated` models get a "Handy pick" badge; `parameters` is shown next to
  size. Catalog order follows Handy; existing sort/filter behavior is unchanged.
- New i18n ids are added to all three locales (en-US, uk-UA, zh-CN).
- Models without a localized description fall back to the English catalog text as
  today (VD-11 fallback path); untranslated new descriptions are accepted for now.

### A5. Engine bump

- `transcribe-cpp` 0.3.1 → 0.4.2 (services + desktop direct dep). This unlocks
  `parakeet-ultra` and `orukeet` (`minEngine: 0.4.0`).
- transcribe-cpp 0.4.x depends on koffi ^3: the workspace koffi override moves
  2.15.6 → 3.0.2 (pnpm-workspace.yaml) together with the direct pin in
  `apps/zcode-cli/packages/adapters`. The only direct koffi usage
  (`windows-job-object.ts`: load/struct/pointer/sizeof) uses stable APIs; typecheck
  and the adapters tests must stay green.
- `STREAM_FAMILY_KINDS` is revisited against the 0.4.x typings; unknown families
  still degrade to one-shot via `selectStreamFamily` returning null.
- The `streaming` flag's meaning changes from "runtime-verified" to "as published by
  the Handy catalog"; the runtime keeps probing `accepts()` before opening a stream,
  so a wrong flag degrades to one-shot, never to a failure.

### A6. Known effects

- `canary-180m-flash` was re-uploaded upstream (new revision, +96 bytes): existing
  downloads fail the size check and re-download once. Expected, one-time.
- Users of Handy-shared model files keep working when the quant file matches. External
  discovery scans Handy's legacy flat models directory AND HuggingFace hub caches
  (`~/.cache/huggingface/hub` plus HF_HUB_CACHE/HF_HOME overrides) — Handy >= 0.10 stores its
  downloads in the hub layout (`models--<org>--<repo>/snapshots/<revision>/<file>`); both verify
  size+sha256 and reuse the file in place.
- Recommend ranking intentionally unchanged; re-tuning ranks for the new models
  (e.g. parakeet-ultra) is a follow-up.

### A7. Acceptance

- Catalog consistency test: unique ids; every model has quants with valid sha256/size;
  `defaultQuant` exists; `minEngine` ≤ shipped engine version; the 13 legacy ids
  survive with stable ids; locale map only on nemotron-3.5.
- Converter fixture test (pure transform + rendered output).
- Store tests cover quant-keyed download/readiness; RPC test covers quant passthrough.
- Model row test covers the quant select and per-quant states.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`,
  `pnpm fmt:check`, voice-related `test:node` entries green.

## Status after the upstream 3.18 sync

The fork merged upstream v3.18.x (voice-input included) while this work was in
flight. Tracks B (capsule), C (voice span), and D (microphone permissions) duplicated what upstream
now ships, so they were dropped from this PR in favor of upstream's implementation; the local
whisper engine keeps its own hook, and wiring it into upstream's voice-input transport remains the
future Track F. This PR carries Track A (catalog/quantizations/engine) and Track E (silence
diagnostics in the local hook).

## Track B — Composer capsule waveform (dropped: upstream 3.18 provides it)

Adopt upstream's recording capsule visual on our engine control: 10 bars × 100 ms
rolling peak history, −50..−10 dBFS → 3..14 px, sky tokens registered as fork design
tokens, 200 ms expand, `motion-reduce` respected, updates confined to the waveform
component (no composer re-render). Our extras stay: cancel button, model status dot,
shortcut tooltip, live region, push-to-talk.

## Track E — Audio diagnostics (LANDED, local hook only)

Recording-side peak statistics: digital silence (all-zero samples), peak below
−50 dBFS, and sub-300 ms recordings produce distinct messages; where the platform
allows, an "open sound settings" action is attached.

## Track D — Microphone permissions via main (dropped: upstream 3.18 provides it)

Optional `IPlatformService` capabilities: system permission precheck, request,
macOS re-authorization (`tccutil reset Microphone <own bundle id>`, dev builds skip
tccutil), fixed system-settings URLs, relaunch. A popover guide anchored to the voice
button replaces today's toast for denied states; Linux keeps the toast path.

## Track C — Voice span in the editor (dropped: upstream 3.18 provides it)

Replace the ghost overlay with an in-document "voice text" span: each preview update
replaces the span content in place; finalize converts it to normal text (empty final
deletes it). Typing during recording soft-finishes the recording; late results never
overwrite user edits; Escape cancels and removes only the span; the span persists with
the draft; one undo record per dictation. One-shot models write the span only at
finalize. Detailed spec (state machine + editor invariants + tests) to be written
before implementation; upstream's matrix is the reference.

## Track F — Local whisper behind the upstream voice-input UI (in flight)

The upstream 3.18 sync left its full voice-input stack in the fork with the hook disabled
("one mic" decision): cloud ASR service, capsule button, permission guide, and the editor
voice-text span. Track F turns that UI on and drives it with the local whisper engine, so
the composer gets upstream's interaction matrix (typing soft-finish, submit-wait, Escape
cancel, draft persistence) over fork-owned, login-free, private transcription.

**Service adapter.** `packages/services/src/voice-input/localWhisperVoiceInput.ts` implements
`IVoiceInputService` on top of the existing `IVoiceDictationService` (managed module
`voice-input-service`): `start` resolves the model from the new optional `start.model` and
`beginStream`s (buffering audio that arrives before `started`), `sendAudio` feeds the stream,
`finish` finalizes and emits `completed`, `cancel` cancels the stream; `result` events carry the
streaming preview's committed text (models without streaming simply emit no `result`). One
session at a time; a new `start` cancels the previous attempt. Errors map to the upstream codes
plus one fork addition, `no_model`, so the UI can offer the voice settings page.

**Hook (fork changes inside `useComposerVoiceInput`).** The engine is local: the login gate
drops, the language comes from the fork dictation settings (`resolveEngineLanguage`) instead of
the zh/en-US cloud pair, `start` carries `{ modelId, quant }` from `voiceDictation` settings, and
a `no_model` failure offers "open voice settings". Post-processing stays UI-owned: on `completed`
the hook runs the configured rewrite through `IVoiceDictationService.postProcess` before the
final voice text lands.

**Composer.** Desktop renders upstream's `VoiceInputButton` (capsule, waveform, permission
guide) with the hook enabled; the fork `V4ComposerDictationControl` keeps serving Web Speech on
web remote and stays in the codebase otherwise unreferenced. Warm-up on composer focus is a
follow-up; the requesting state covers model load in the meantime.
