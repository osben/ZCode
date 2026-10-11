import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

export const CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX = 32;
export const CONVERSATION_BOTTOM_DOCK_ENTER_SCALE = 0.96;
export const CONVERSATION_BOTTOM_DOCK_EXIT_SCALE = 0.97;
export const CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS = 0.26;
export const CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS = 0.18;
export const CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING = [0.23, 1, 0.32, 1] as const;

const CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM = "translate3d(0, 0, 0) scale(1)";
const CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_ENTER_SCALE})`;
const CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM = `translate3d(0, ${CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX}px, 0) scale(${CONVERSATION_BOTTOM_DOCK_EXIT_SCALE})`;

export function resolveConversationBottomDockMotion(prefersReducedMotion: boolean) {
  if (prefersReducedMotion) {
    return {
      initial: false as const,
      animate: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
      exit: {
        opacity: 1,
        transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
        transition: { duration: 0 },
      },
    };
  }

  return {
    initial: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_ENTER_TRANSFORM,
    },
    animate: {
      opacity: 1,
      transform: CONVERSATION_BOTTOM_DOCK_VISIBLE_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
    exit: {
      opacity: 0,
      transform: CONVERSATION_BOTTOM_DOCK_EXIT_TRANSFORM,
      transition: {
        duration: CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS,
        ease: CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      },
    },
  };
}

export function ConversationBottomDockTransition({
  mode,
  children,
}: {
  mode: "chat" | "confirmation";
  children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationBottomDockMotion(prefersReducedMotion);

  return (
    <div data-testid="conversation-bottom-dock-transition" className="grid w-full">
      {/* Bugfix: chat and the confirmation area have different heights. Share a grid cell and align
          at the bottom so changing the parent height does not make the exiting layer jump before it animates. */}
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={mode}
          data-testid="conversation-bottom-dock-transition-layer"
          data-conversation-bottom-dock-mode={mode}
          // Grid items default to min-width:auto, with a minimum size equal to the content's min-content width.
          // The implicit column track is auto and is held to that minimum, so when the panel narrows, the composer
          // still keeps its min-content width (about 465px), overflows the container, and gets clipped on the right.
          // min-w-0 disables the automatic minimum size so the track can shrink with the container.
          className="col-start-1 row-start-1 w-full min-w-0 origin-bottom self-end will-change-transform"
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
