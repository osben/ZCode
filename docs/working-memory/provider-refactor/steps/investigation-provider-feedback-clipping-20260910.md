# Provider Banner Clipping: Pro Runtime Investigation

> 2026-09-10. Status: the original screenshot was not reproduced and the root cause is not confirmed; it must not be marked fixed. This round only diagnosed and changed no product code.
>
> User decision afterwards: ignore this item for now. Keep the record; do not continue implementation or use it as a completion prerequisite for other items. The round's to-do summary is at [Todo107](./todo-107-provider-settings-feedback-enablement-and-template-links.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/investigation-provider-feedback-clipping-20260910.md`

## Phenomenon

On the Air, the lower half of the connectivity-test success banner is missing; the model row is still visible; another
model's testing-in-progress banner sits below it (original attachment: clipboard screenshot
`d51e6f7f-bf4e-4753-bdbd-87056848d5b3.png`).

## Investigation

- The Pro does not run ZCode; Electron was started from an older existing development build over CDP, so it is not a
  same-version check against the Air. The renderer resources were extracted from the Air's installed package and
  loaded in a Pro temporary directory (source and original build untouched); the Host stayed the Pro's original build
  (account/config DTO mismatch), so this is frontend layout diagnosis only, not same-version full-app acceptance.
- Both Electron 41.0.3, both macOS 26.6.2; Air M4, Pro M5; Pro GPU compositing and Metal enabled.
- Temporary success/pending states were injected through the original `ProviderDetailFeedbackBoundary` Context (no model
  call, no Provider save); another model row's `isTesting` was set to reproduce the spinner; the list position was
  adjusted so the model row sits below the banner. Checks: 2/3 prompts, removing the middle prompt, window resize,
  scroll, model-row transform; recorded ancestor overflow, z-index, boundary and compositing layers.
- Two prompts: 44 CSS px each, 8 px spacing, 96 px total, inside the detail panel boundary; banner viewport z-index 20.
  The compositing layer reason includes BackdropFilter, but that is no evidence it causes the fault.
- 12 consecutive rounds of prompt/scroll changes gave 68 screencast frames; 12 sampled frames saved, frames
  0/3/6/9/11 manually checked: the clipped lower half was not seen; per-round DOM hit checks found the banner bottom
  never covered by the model row.
- System `screencapture` still returned `could not create image from display` after the Pro was woken (screen
  recording permission/security settings were not modified); CDP screenshots/recording work but do not replace the
  missing system screen evidence.

## Conclusion and Next Steps

Under this round's conditions no ordinary CSS layer or parent overflow clips the banner. This does not deny the user's
screenshot nor exclude a layout problem under other timing/device conditions. "backdrop-filter and GPU compositing
rendering anomaly" is only a candidate with no before/after evidence; claiming it as root cause, or adding z-index /
removing the blur as a verified fix, is prohibited.

Next: when truly reproduced on the Air, connect CDP and record banner rect, compositing layers and a screenshot at the
same time, then do a single-variable in-memory style comparison (e.g. remove the blur, disable the related animation).
The Air has no debugging port; confirm with the user before restarting it; do not interrupt its task without
authorization. When a fix is implemented a formal reproducible case must be left.

Temporary evidence (local, not permanent regression evidence): `/tmp/pro-banner-stress-evidence.json` (per-round
geometry and hit results), `/tmp/pro-banner-frame-0.png` to `11.png`, `/tmp/pro-banner-row-spinner.png`,
diagnostic scripts `/tmp/zcode-banner-stress.cjs`, `/tmp/zcode-pro-banner-cdp.cjs`.
