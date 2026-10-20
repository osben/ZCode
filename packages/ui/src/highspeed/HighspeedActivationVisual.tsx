import { memo, useCallback, useEffect, useState } from "react";
import { FloatingParticles } from "@/components/ui/floating-particles.js";
import { HighSpeedDiffusionCanvas } from "@/v4/highspeed/HighSpeedDiffusionCanvas.js";

type HighspeedVisualPhase = "diffusing" | "handoff" | "stable";

const HIGHSPEED_HANDOFF_FALLBACK_MS = 1_000;

/**
 * Renders only the visual layer of the Highspeed composer shell; activation eligibility, validity
 * window, and model are still decided by the outer card snapshot.
 */
export const HighspeedComposerBackground = memo(function HighspeedComposerBackground({
  animated,
  onModelTransitionStart,
}: {
  /**
   * Whether this is the activation entrance for a fresh draw hit. A resumed entrance mounts
   * directly at stable without the diffusion Canvas; the entrance style only applies at mount,
   * and the host keys by cardId.
   */
  animated: boolean;
  onModelTransitionStart: () => void;
}) {
  const [phase, setPhase] = useState<HighspeedVisualPhase>(animated ? "diffusing" : "stable");
  const handleHandoffStart = useCallback(() => setPhase("handoff"), []);
  const handleDiffusionComplete = useCallback(() => setPhase("stable"), []);

  useEffect(() => {
    if (phase !== "handoff") return;
    // Bug root cause: when the window is backgrounded or the Renderer is busy, the Canvas's
    // opacity transitionend may be lost, leaving the animation stuck at handoff forever, which
    // also removes the purple border and shadow that only apply at stable.
    // The normal path still settles precisely via transitionend; the timeout only advances the
    // event-lost state machine to the stable phase.
    const fallbackTimer = window.setTimeout(handleDiffusionComplete, HIGHSPEED_HANDOFF_FALLBACK_MS);
    return () => window.clearTimeout(fallbackTimer);
  }, [handleDiffusionComplete, phase]);

  return (
    <div
      data-testid="highspeed-composer-background"
      data-phase={phase}
      aria-hidden="true"
      className="highspeed-composer-background pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
    >
      {phase !== "stable" ? (
        <HighSpeedDiffusionCanvas
          onModelTransitionStart={onModelTransitionStart}
          onHandoffStart={handleHandoffStart}
          onComplete={handleDiffusionComplete}
        />
      ) : null}
      <FloatingParticles className="highspeed-particle-layer z-0" settled={!animated} />
    </div>
  );
});
