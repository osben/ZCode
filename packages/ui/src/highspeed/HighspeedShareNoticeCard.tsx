import { useEffect, useState, type CSSProperties } from "react";
import { CopyIcon, EyeIcon, XIcon, ZapIcon } from "lucide-react";
import { animate, motion, useReducedMotion } from "motion/react";
import shareCardDarkBackgroundUrl from "@/assets/highspeed/share-card.svg";
import shareCardLightBackgroundUrl from "@/assets/highspeed/share-card-light.svg";
import shareDialogNoiseUrl from "@/assets/highspeed/share-dialog-noise.png";
import shareDialogNoiseLightUrl from "@/assets/highspeed/share-dialog-noise-light.png";
import zaiLogoUrl from "@/assets/highspeed/zai-logo.png";
import { Button } from "@/components/ui/button.js";
import { ZCodeWordmarkLogo } from "@/components/ui/ZCodeAboutLogo.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import {
  copyHighspeedCardImage,
  copyHighspeedShareText,
  formatHighspeedDurationShort,
  highspeedSavedPercent,
  highspeedSpeedup,
  isHighspeedShareEligible,
  isHighspeedShareNoticePayload,
  resolveHighspeedShareNoticeMetrics,
} from "@/highspeed/highspeedShare.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

export function HighspeedShareNoticeCard({
  notice,
  onDismiss,
}: {
  notice: GlobalNoticeEnvelope;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const payload = isHighspeedShareNoticePayload(notice.payload) ? notice.payload : null;
  if (!payload) return null;
  // Bug root cause: metrics were previously rebuilt from second-rounded fields before rechecking
  // eligibility, so borderline multipliers were systematically underestimated and the View button
  // was hidden (spec §9). Now the publish gate and this recheck share the same millisecond facts,
  // so the recheck always agrees with the publish decision and defense-in-depth no longer
  // penalizes already-published cards.
  const metrics = resolveHighspeedShareNoticeMetrics(payload);
  const shareEligible = isHighspeedShareEligible(metrics);
  const openDetails = () => setOpen(true);
  return (
    <>
      <div className="highspeed-sidebar-share-card-frame">
        <section
          className="highspeed-sidebar-share-card"
          aria-label={intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          data-global-notice-type="highspeed-share"
          role="group"
        >
          {/* Bug cause: the old implementation split the design mock's background into several
           * approximate layers, which could double-stack or lose strokes on theme switches.
           * Use the complete themed background delivered by design as-is; foreground elements
           * still render independently at their Figma coordinates. */}
          <img
            src={shareCardLightBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--light"
            data-highspeed-card-background="light"
          />
          <img
            src={shareCardDarkBackgroundUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="highspeed-sidebar-share-card__background highspeed-sidebar-share-card__background--dark"
            data-highspeed-card-background="dark"
          />
          <div className="highspeed-sidebar-share-card__content">
            <div className="highspeed-sidebar-share-card__title" role="img" aria-label="ZCode">
              <ZCodeWordmarkLogo className="highspeed-sidebar-share-card__wordmark" />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
              className="highspeed-sidebar-share-card__close absolute right-2.5 top-2.5 z-2 rounded-full text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:ring-foreground/50"
              onClick={onDismiss}
            >
              <XIcon aria-hidden="true" />
            </Button>
            {shareEligible ? (
              <Button
                type="button"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.view" })}
                className="highspeed-sidebar-share-card__view"
                onClick={openDetails}
              >
                <EyeIcon aria-hidden="true" className="size-3" strokeWidth={2} />
                {intl.formatMessage({ id: "globalNotice.highspeed.view" })}
              </Button>
            ) : null}
            <div className="highspeed-sidebar-share-card__model">
              <ZapIcon aria-hidden="true" className="highspeed-sidebar-share-card__model-icon" />
              <span className="highspeed-sidebar-share-card__model-text">GLM-5.3-Highspeed</span>
            </div>
            <div className="highspeed-sidebar-share-card__description">
              {intl.formatMessage({ id: "globalNotice.highspeed.sidebarTagline" })}
            </div>
          </div>
        </section>
      </div>
      <HighspeedShareDialog metrics={metrics} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Counts from 0 up to the target value; with reduced motion or when disabled, the final value is shown directly. Timing aligns with the staggered fade-up of the card sections. */
function useCountUpNumber(
  target: number,
  { enabled, delayMs, durationMs }: { enabled: boolean; delayMs: number; durationMs: number },
) {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setValue(target);
      return;
    }
    setValue(0);
    const controls = animate(0, target, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setValue,
    });
    return () => controls.stop();
  }, [target, enabled, delayMs, durationMs]);
  return value;
}

export function HighspeedShareDialog({
  metrics,
  open,
  onOpenChange,
}: {
  metrics: {
    outputTokens: number;
    durationMs: number;
    regularTps: number;
    highspeedTps: number;
    savedDurationMs?: number;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion();
  const speedup = highspeedSpeedup(metrics);
  const savedDurationMs = metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
  const savedSeconds = Math.max(0, Math.round(savedDurationMs / 1_000));
  // Bug cause: this was previously 1 - highspeedTps/regularTps, which is always negative and got
  // clamped to 0%.
  const savedPercent = highspeedSavedPercent(metrics);
  // The multiplier and percentage count up from 0 to their targets as the dialog enters; timing
  // matches each section's fade-up delay of 230ms/300ms.
  const countUpEnabled = open && !prefersReducedMotion;
  const speedupCount = useCountUpNumber(speedup, {
    enabled: countUpEnabled,
    delayMs: 230,
    durationMs: 900,
  });
  const savedPercentCount = useCountUpNumber(savedPercent, {
    enabled: countUpEnabled,
    delayMs: 300,
    durationMs: 900,
  });
  const copyImage = () =>
    void copyHighspeedCardImage(metrics, undefined, {
      benefit: intl.formatMessage({ id: "globalNotice.highspeed.badge" }),
      standardSpeed: intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" }),
      speedSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.speedSummary" },
        { duration: formatHighspeedDurationShort(metrics.durationMs) },
      ),
      lessWaiting: intl.formatMessage(
        { id: "globalNotice.highspeed.lessWaiting" },
        { percent: savedPercent },
      ),
      imageSummary: intl.formatMessage(
        { id: "globalNotice.highspeed.imageSummary" },
        { tokens: Math.floor(metrics.outputTokens).toLocaleString(), duration: savedSeconds },
      ),
    })
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.imageCopyFailed" })));
  const shareText = intl.formatMessage(
    { id: "globalNotice.highspeed.copySummary" },
    { tokens: metrics.outputTokens.toLocaleString(), duration: savedSeconds },
  );
  const copyText = () =>
    void copyHighspeedShareText(shareText)
      .then(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopied" })))
      .catch(() => toast(intl.formatMessage({ id: "globalNotice.highspeed.textCopyFailed" })));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bug cause: Radix Presence unmounts overlay/content only on the exiting CSS animation's
       * animationend, with no timeout fallback; when the Electron window is invisible the
       * compositor stalls and animationend never fires, so the bg-black/60 overlay lingers
       * forever, graying out and swallowing clicks on the bottom-left view button. The closed
       * state forces animation:none via highspeed-share.css, so Radix detects no animation name
       * and unmounts synchronously (tw-merge does not merge tw-animate's animate-out, making a
       * class-name approach unreliable). */}
      <DialogContent
        className="highspeed-share-dialog__content"
        overlayClassName="highspeed-share-dialog__overlay"
        showCloseButton={false}
      >
        <motion.section
          className="highspeed-share-dialog__card"
          data-highspeed-share-dialog-card="true"
          initial={
            prefersReducedMotion
              ? false
              : { opacity: 0, rotateY: -72, rotateX: 4, scale: 0.9, y: 10 }
          }
          animate={{ opacity: 1, rotateY: 0, rotateX: 0, scale: 1, y: 0 }}
          transition={{ duration: 0.68, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: "50% 50%", transformPerspective: 1200 }}
        >
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--dark"
            style={{ backgroundImage: `url(${shareDialogNoiseUrl})` }}
            aria-hidden="true"
          />
          <div
            className="highspeed-share-dialog__noise highspeed-share-dialog__noise--light"
            style={{ backgroundImage: `url(${shareDialogNoiseLightUrl})` }}
            aria-hidden="true"
          />
          <div className="highspeed-share-dialog__header">
            <div className="highspeed-share-dialog__brand">
              <span className="highspeed-share-dialog__logo" aria-hidden="true">
                <img src={zaiLogoUrl} alt="" draggable={false} />
              </span>
              <span className="highspeed-share-dialog__benefit">
                {intl.formatMessage({ id: "globalNotice.highspeed.badge" })}
              </span>
              <span className="highspeed-share-dialog__pill">
                {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
              </span>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "globalNotice.highspeed.close" })}
                className="highspeed-share-dialog__close"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <DialogTitle className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "globalNotice.highspeed.tagline" })}
          </DialogDescription>
          <div className="highspeed-share-dialog__metric">
            <span className="highspeed-share-dialog__metric-value">
              {speedupCount.toFixed(1)}
              <span className="highspeed-share-dialog__metric-suffix"> x</span>
            </span>
            <span className="highspeed-share-dialog__metric-label">
              {intl.formatMessage({ id: "globalNotice.highspeed.standardTaskSpeed" })}
            </span>
          </div>
          <div className="highspeed-share-dialog__stats">
            <div className="highspeed-share-dialog__stats-header text-ui-sm">
              <span className="highspeed-share-dialog__stats-label">
                <ZapIcon aria-hidden="true" fill="currentColor" strokeWidth={0} />
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.speedSummary" },
                  { duration: formatHighspeedDurationShort(metrics.durationMs) },
                )}
              </span>
              <span className="highspeed-share-dialog__saved text-ui-sm">
                {intl.formatMessage(
                  { id: "globalNotice.highspeed.lessWaiting" },
                  { percent: Math.round(savedPercentCount) },
                )}
              </span>
            </div>
            <div
              className="highspeed-share-dialog__chart"
              aria-hidden="true"
              style={
                {
                  "--highspeed-share-fast-width": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                  "--highspeed-share-marker-left": `calc(${Math.max(1, 100 - savedPercent)}% + 1px)`,
                } as CSSProperties
              }
            >
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--baseline"
                aria-hidden="true"
              />
              <span
                className="highspeed-share-dialog__chart-bars highspeed-share-dialog__chart-bars--fast"
                aria-hidden="true"
              />
              <span className="highspeed-share-dialog__chart-marker" />
            </div>
            <div className="highspeed-share-dialog__actions">
              <button
                type="button"
                className="highspeed-share-dialog__url"
                onClick={copyText}
                title={shareText}
                aria-label={shareText}
              >
                <span>{shareText}</span>
                <CopyIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="highspeed-share-dialog__download"
                onClick={copyImage}
              >
                {intl.formatMessage({ id: "globalNotice.highspeed.copyImage" })}
              </button>
            </div>
          </div>
        </motion.section>
      </DialogContent>
    </Dialog>
  );
}
