import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

export const SUMMARY_ROLL_TRANSITION_MS = 300;
export const SUMMARY_ROLL_HOLD_MS = 500;
export const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;
const SUMMARY_ROLL_TRANSITION = {
  duration: SUMMARY_ROLL_TRANSITION_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;

function getCurrentTimestamp() {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

export function resolveQueuedSummaryPlaybackQueue<T>(
  queuedContent: readonly T[],
  timerDriftMs: number,
): T[] {
  if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queuedContent.length > 1) {
    return queuedContent.slice(-1);
  }
  return [...queuedContent];
}

export function shouldAnimateQueuedSummaryContent({
  enabled,
  disableAnimation,
  reducedMotion,
}: {
  enabled: boolean;
  disableAnimation?: boolean;
  reducedMotion: boolean;
}) {
  return enabled && disableAnimation !== true && !reducedMotion;
}

interface SummaryContentSnapshot {
  key: string;
  refreshVersion?: unknown;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function QueuedSummaryContent({
  contentKey,
  contentRefreshVersion,
  primaryText,
  secondaryText,
  trailingText,
  enabled,
  disableAnimation = false,
}: {
  contentKey: string;
  contentRefreshVersion?: unknown;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
  enabled: boolean;
  disableAnimation?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = shouldAnimateQueuedSummaryContent({
    enabled,
    disableAnimation,
    reducedMotion,
  });
  if (!shouldAnimate) {
    // #185：禁用动画时逐 token 在 effect 里复制 state，会在连续同步提交中积累嵌套更新。
    // 静态路径直接显示输入；卸载播放 owner 同时释放旧队列，重新启用从当前内容开始。
    return (
      <>
        {primaryText}
        {secondaryText}
        {trailingText}
      </>
    );
  }

  return (
    <AnimatedSummaryContent
      content={{
        key: contentKey,
        refreshVersion: contentRefreshVersion,
        primaryText,
        secondaryText,
        trailingText,
      }}
    />
  );
}

function AnimatedSummaryContent({ content }: { content: SummaryContentSnapshot }) {
  const [displayedContent, setDisplayedContent] = useState(content);
  const displayedContentRef = useRef(content);
  const queuedContentRef = useRef<SummaryContentSnapshot[]>([]);
  const animationTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    const clearAnimationTimer = () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
    const enqueue = (snapshot: SummaryContentSnapshot) => {
      const queue = queuedContentRef.current;
      const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
      if (existingIndex >= 0) {
        // While a file summary is queued for display, incoming diffs update the same snapshot; key deduplication must not
        // preserve the earliest +N/-N, nor should each value change add a full scrolling item.
        const nextQueue = [...queue];
        nextQueue[existingIndex] = snapshot;
        queuedContentRef.current = nextQueue;
        return;
      }

      if (queue.length === 0) {
        queuedContentRef.current = [snapshot];
        return;
      }

      // The summary scroller can have only three slots total: currently displayed, next, and an interruptible item.
      // queuedContentRef stores only the latter two; never overwrite the second slot, and let new summaries replace only the third.
      queuedContentRef.current = [queue[0]!, snapshot].slice(0, SUMMARY_ROLL_MAX_PENDING);
    };
    const promote = (snapshot: SummaryContentSnapshot) => {
      displayedContentRef.current = snapshot;
      setDisplayedContent(snapshot);
      isAnimatingRef.current = true;
      clearAnimationTimer();
      const expectedTimerAt = getCurrentTimestamp() + SUMMARY_ROLL_TOTAL_MS;
      animationTimerRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        animationTimerRef.current = null;
        const queuedContent = queuedContentRef.current;
        const timerDrift = getCurrentTimestamp() - expectedTimerAt;
        // A timeout may arrive late when the main thread is busy; if old summaries continue playing one by one,
        // users see stale states queued up after the stall clears, making the UI feel even more sluggish.
        const nextQueue = resolveQueuedSummaryPlaybackQueue(queuedContent, timerDrift);
        const [nextQueued, ...restQueued] = nextQueue;
        if (!nextQueued) {
          queuedContentRef.current = [];
          return;
        }
        queuedContentRef.current = restQueued;
        promote(nextQueued);
      }, SUMMARY_ROLL_TOTAL_MS);
    };
    const nextContent = content;
    if (displayedContentRef.current.key === nextContent.key) {
      // Body text and counts of the same summary derive straight from the input, so no setState here; the outer group
      // header also updates per token. Only keep the last displayed snapshot after commit, so the current item's latest
      // content still freezes when the next item queues.
      displayedContentRef.current = nextContent;
      return;
    }

    if (isAnimatingRef.current) {
      enqueue(nextContent);
      return;
    }

    if (queuedContentRef.current.length > 0) {
      enqueue(nextContent);
      return;
    }

    promote(nextContent);
  }, [content]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  // state 只推进播放项；ref 保存该项的最新已提交输入，不在 render 中写入。
  const renderedContent =
    content.key === displayedContent.key ? content : displayedContentRef.current;

  return (
    <span className="relative inline-flex min-w-0 items-center gap-2 overflow-hidden align-middle">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={renderedContent.key}
          className="inline-flex min-w-0 items-center gap-2"
          initial={{ y: "0.8em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={SUMMARY_ROLL_TRANSITION}
        >
          {renderedContent.primaryText}
          {renderedContent.secondaryText}
        </motion.span>
      </AnimatePresence>
      {/* Reason for the fix: The Changes diff count must come from the same queued snapshot as the file summary,
          but the number should keep animating independently with FlipMetricValue rather than scrolling vertically with the whole summary. */}
      {renderedContent.trailingText}
    </span>
  );
}
