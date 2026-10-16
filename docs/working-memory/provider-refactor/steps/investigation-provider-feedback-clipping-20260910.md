# Provider Banner Clipping: Pro Runtime Investigation

> 2026-09-10. Status: The original image is not reproduced, and the root cause is not confirmed; it must not be marked as fixed. This round only diagnoses, without modifying the product code.

> The subsequent user decision: ignore this item first. Keep the investigation record; do not continue implementation or use it as a completion prerequisite for other items in this round; the to-do summary of this round is at [Todo107](./todo-107-provider-settings-feedback-enablement-and-template-links.md).

## The Original Phenomenon

The lower half of the Air connectivity test success banner is missing; the model row is still visible; and there is another model's testing-in-progress banner below. The original attachment: the clipboard screenshot `d51e6f7f-bf4e-4753-bdbd-87056848d5b3.png`.

## The Actual Investigation

- The Pro does not run the ZCode; it starts the Electron from the existing development build and connects to the CDP. It is discovered that its build is relatively old, and cannot be used as the Air same-version verification.
- The renderer resources are extracted only from the Air's current installation package, and this actual frontend is loaded in the Pro's temporary directory. The source code or the original build is not replaced. The Host is still the Pro's original build; the account/config DTO is inconsistent, and is therefore only used for the frontend layout diagnosis, and does not represent the full application same-version acceptance.
- Both Electron instances are 41.0.3; both macOS are 26.6.2; the Air is M4, and the Pro is M5. The Pro GPU compositing and Metal are both enabled.
- The temporary success/pending is injected through the original `ProviderDetailFeedbackBoundary`'s Context, without calling the model interface or saving the Provider config; another model row's temporary isTesting state is also set to reproduce the original image's spinning animation. The temporary list position adjustment makes the model row located below the banner.
- Check 2/3 prompts, remove the middle prompt, change the window size, scroll, and the model row transform. Record the ancestor overflow, z-index, boundary, and the composite layer.
- The 2-prompt test height is 44 CSS px each, the spacing is 8 px, and the overall is 96 px; it is located within the detail panel boundary, and the banner viewport's z-index is 20. The reason for the composite layer includes the BackdropFilter, but this is not the evidence that it causes the failure.
- The continuous 12 rounds of prompts/scroll changes receive 68 screencast frames; 12 sampling frames are saved, and 0/3/6/9/11 are manually spot-checked; the original image's lower half disappearing is not seen. Each round of the DOM banner bottom hit check does not find that it is covered by the model row.
- The system screencapture still returns `could not create image from display` after the user wakes up the Pro; the screen recording permission or the security setting is not modified. The CDP screenshot/recording is available, but they cannot be used to replace the unobtained system screen evidence.

## Conclusion and Next Steps

Under the reproduction conditions of this round, no ordinary CSS layer or the parent container overflow is found to clip the banner in half. This conclusion does not deny the user's screenshot, nor can it completely exclude the layout problem under other timing/device conditions.

"The backdrop-filter and GPU compositing rendering anomaly" is still only a candidate; there is no evidence comparing the before and after of the failure; claiming the root cause based on this, or directly adding the z-index / deleting the blur as the verified fix, is prohibited.

The next step should connect the CDP when it is truly reproduced on the Air, record the banner rect, the composite layer, and the screen shot at the same time, and then do the single variable comparison (such as deleting the blur, disabling the relevant animation) that only affects the memory style. The Air currently has no debugging port; confirmation with the user before restart is required; the task cannot be interrupted without authorization.

## Temporary Evidence

- The local `/tmp/pro-banner-stress-evidence.json`: the geometry and hit result of each round.
- The local `/tmp/pro-banner-frame-0.png` to `11.png`: the sampling frames.
- The local `/tmp/pro-banner-row-spinner.png`: the model row and the banner spinning simultaneously scenario.
- The local `/tmp/zcode-banner-stress.cjs`, `/tmp/zcode-pro-banner-cdp.cjs`: the diagnostic script, not the formal test or the production code.

The above is the temporary diagnostic file, not the permanent regression evidence; when the fix is implemented, the formal reproducible case must still be left.
