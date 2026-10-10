import type { BrowserScreenshotActivityLease } from "./browserScreenshotSurfaceContracts.js";
import {
  DesktopBrowserScreenshotTransientRetry,
  isTransientScreenshotCaptureError,
} from "./browserScreenshotTransientRetry.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";

interface BrowserWindowForActivity extends BrowserWindowForTransparentBootstrap {
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
  };
}

interface GuestWebContentsForActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

interface ScreenshotActivityState {
  key: string;
  windowId: number;
  webContentsId: number;
  tokens: Map<symbol, { prepared: boolean }>;
  restoreGeneration: number;
  active: boolean;
  invalidationController: AbortController;
  transparentWindowBootstrap?: TransparentWindowBootstrap;
  capturePumpsAllowed: boolean;
  capturePumpStartTimer?: ReturnType<typeof setTimeout>;
  pumps: Record<"owner" | "guest", CapturePumpRuntime>;
}

interface CapturePumpRuntime {
  running: boolean;
  wakeDelay?: () => void;
  transientRetry: DesktopBrowserScreenshotTransientRetry;
}

/** 1×1 probe result: transient means a self-recovering failure such as the Viz surface not yet being ready. */
type CaptureProbeOutcome = { ok: true } | { ok: false; transient: boolean };

const CAPTURE_PROBE_SUCCEEDED: CaptureProbeOutcome = { ok: true };
const CAPTURE_PROBE_FATAL: CaptureProbeOutcome = { ok: false, transient: false };
const CAPTURE_PROBE_TRANSIENT: CaptureProbeOutcome = { ok: false, transient: true };

const ACTIVITY_CAPTURE_RECT = { x: 0, y: 0, width: 1, height: 1 };
const CAPTURING_GUEST_MIN_INTERVAL_MS = 200;

/**
 * Manage short-lived background-activity leases per owner BrowserWindow.
 *
 * Electron's backgroundThrottling=false wakes every WebContents in the same BrowserWindow.
 * browser-use tabs also live as long as their process; permanently disabling throttling at window
 * creation would keep the renderer, all guests, and GPU rendering after the window moves to the
 * background. Dynamically setting it back to true does not trigger hidden scheduling again.
 * During a screenshot preparation group, maintain reversible capturer counts for both the owner
 * renderer and target guest. Chromium's native capture lifecycle restores background throttling at
 * the end without waking other guests in the same window.
 */
export class DesktopBrowserScreenshotActivityController {
  private readonly states = new Map<string, ScreenshotActivityState>();

  constructor(
    private readonly options: {
      fromId(windowId: number): BrowserWindowForActivity | null;
      fromWebContentsId(webContentsId: number): GuestWebContentsForActivity | null;
      allowTransparentWindowBootstrap?: boolean;
      hideTaskbarDuringTransparentWindowBootstrap?: boolean;
      log?(message: string): void;
    },
  ) {}

  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot";
  }): BrowserScreenshotActivityLease | undefined {
    const stateKey = this.getStateKey(input.windowId, input.webContentsId);
    let state = this.states.get(stateKey);
    if (state && !state.active) {
      this.states.delete(stateKey);
      state = undefined;
    }
    if (!state) {
      const targets = this.resolveActivityTargets(input.windowId, input.webContentsId);
      if (!targets) {
        this.options.log?.(
          `[browser-screenshot-activity] acquire skipped windowId=${input.windowId} webContentsId=${input.webContentsId} requestId=${input.requestId}`,
        );
        return undefined;
      }
      const transparentWindowBootstrap = startBrowserScreenshotTransparentWindowBootstrap({
        win: targets.window,
        enabled: this.options.allowTransparentWindowBootstrap === true,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        requestId: input.requestId,
        hideTaskbarDuringBootstrap:
          this.options.hideTaskbarDuringTransparentWindowBootstrap === true,
        log: this.options.log,
      });
      if (transparentWindowBootstrap === false) {
        return undefined;
      }
      state = {
        key: stateKey,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        tokens: new Map(),
        restoreGeneration: 0,
        active: true,
        invalidationController: new AbortController(),
        transparentWindowBootstrap,
        capturePumpsAllowed: !transparentWindowBootstrap,
        pumps: {
          owner: { running: false, transientRetry: this.createTransientRetry() },
          guest: { running: false, transientRetry: this.createTransientRetry() },
        },
      };
      this.states.set(stateKey, state);
      this.scheduleCapturePumpsAfterTransparentBootstrap(state);
    } else {
      // Cancel the microtask pump stop scheduled by the previous lease; consecutive screenshots reuse the same capturer activity.
      state.restoreGeneration += 1;
      state.pumps.owner.transientRetry.reset();
      state.pumps.guest.transientRetry.reset();
    }

    const token = Symbol(input.requestId);
    state.tokens.set(token, { prepared: false });
    this.wakeCapturePumps(state);
    this.ensureCapturePumps(state);
    let released = false;
    return {
      invalidated: state.invalidationController.signal,
      markPrepared: () => {
        if (released) return;
        const leaseState = state.tokens.get(token);
        if (!leaseState || leaseState.prepared) return;
        leaseState.prepared = true;
        this.maybeReleaseTransparentWindowBootstrap(state);
        // Continuing back-to-back CopyFromSurface on the owner/guest after Ready could turn the
        // entire 35-second watchdog into high-frequency GPU readbacks. The owner completed its rAF
        // handshake and should stop pumping; the guest only needs low-frequency progress while
        // hidden, so switch to single in-flight 5 Hz pulses.
        this.wakeCapturePumps(state);
        this.ensureCapturePumps(state);
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseToken(stateKey, state, token);
      },
    };
  }

  private releaseToken(stateKey: string, state: ScreenshotActivityState, token: symbol): void {
    if (this.states.get(stateKey) !== state || !state.tokens.delete(token)) return;
    this.wakeCapturePumps(state);
    if (state.tokens.size > 0) return;

    const restoreGeneration = ++state.restoreGeneration;
    queueMicrotask(() => {
      if (
        this.states.get(stateKey) !== state ||
        state.tokens.size > 0 ||
        state.restoreGeneration !== restoreGeneration
      ) {
        return;
      }
      state.active = false;
      this.releaseTransparentWindowBootstrap(state);
      this.wakeCapturePumps(state);
      if (this.states.get(stateKey) === state) {
        this.states.delete(stateKey);
      }
    });
  }

  private async runCapturePump(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<void> {
    const runtime = state.pumps[target];
    runtime.running = true;
    let pendingStartedAt = Date.now();
    let pending: Promise<CaptureProbeOutcome> | undefined = this.captureOnce(state, target);
    try {
      while (pending) {
        const mode = this.getPumpMode(state, target);
        if (mode === "stopped") {
          const completed = await pending;
          if (!completed.ok) this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }

        if (mode === "continuous") {
          // During prepare, start the next probe before waiting for the previous one so the owner's
          // two-frame stability check is not rescheduled as hidden when the capturer count reaches
          // zero. Keep at most two in flight per target.
          const nextStartedAt = Date.now();
          const next = this.captureOnce(state, target);
          const completed = await pending;
          if (!completed.ok) {
            if (!completed.transient) {
              // Preserve fast-fail behavior for fatal errors: do not wait for a concurrent probe that
              // may remain pending forever (capturePage can hang for a hidden window). Invalidate
              // immediately; pending is resolved, the loop drains through its stopped branch at the
              // top, and the in-flight probe is handled inside captureOnce without an unhandled rejection.
              this.invalidateActivity(state, target);
              continue;
            }
            // Wrap the follow-up probe in an object: an async function returning a Promise directly
            // would adopt it and wait for it to settle before returning, stopping the pump on a
            // serial probe and preventing the overlapping cadence from resuming.
            const recovered = await this.recoverFromPreparingCaptureFailure(
              state,
              runtime,
              target,
              next,
            );
            pending = recovered?.pending;
            continue;
          }
          runtime.transientRetry.reset();
          pending = next;
          pendingStartedAt = nextStartedAt;
          // Electron's 1×1 capturePage may resolve immediately for a hidden window. Continuing the
          // pump directly here would let Promise continuations occupy the microtask queue forever,
          // preventing Ready IPC, timeouts, watchdogs, and second-instance events from running; the
          // app would appear frozen and fail to open. Keep capturer overlap by starting the next
          // probe first, but yield to the main event loop every round.
          await this.waitForContinuousCaptureTurn(state, runtime, target);
          continue;
        }

        const completed = await pending;
        if (!completed.ok) {
          this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }
        pending = undefined;
        await this.waitForGuestCaptureSlot(state, runtime, pendingStartedAt);
        if (this.getPumpMode(state, target) === "stopped") continue;
        pendingStartedAt = Date.now();
        pending = this.captureOnce(state, target);
      }
    } finally {
      runtime.wakeDelay = undefined;
      runtime.running = false;
      if (this.getPumpMode(state, target) !== "stopped") {
        this.ensureCapturePump(state, target);
      }
    }
  }

  /**
   * Before the first frame of a newly activated guest is composited, the prepare-stage 1×1 probe in
   * the same turn as a screenshot request may encounter an uninitialized Viz surface and throw
   * UnknownVizError. Treating every probe failure as fatal would invalidate the first screenshot
   * within 45 ms and force the Agent to retry the whole operation.
   * UnknownVizError is transient: the same request succeeds as soon as the surface exists. The first
   * failure reaching this function is confirmed transient. Wait for the concurrent next probe to
   * settle first (do not issue another CopyFromSurface concurrently while handling a failure;
   * concurrent readback before surface readiness has triggered SIGSEGV in smoke testing), then retry
   * serially with backoff. When the budget is exhausted or the concurrent probe has a fatal error,
   * return to the existing fast-fail invalidate behavior. Failures after Ready (the paced stage)
   * still invalidate immediately; do not relax them.
   */
  private async recoverFromPreparingCaptureFailure(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
    next: Promise<CaptureProbeOutcome>,
  ): Promise<{ pending: Promise<CaptureProbeOutcome> } | undefined> {
    const nextCompleted = await next;
    if (nextCompleted.ok) {
      // The concurrent probe succeeded, so the surface is ready; skip backoff and restore the normal overlapping cadence.
      runtime.transientRetry.reset();
      return { pending: this.captureOnce(state, target) };
    }
    if (
      !nextCompleted.transient ||
      !runtime.transientRetry.schedule({
        target,
        windowId: state.windowId,
        webContentsId: state.webContentsId,
      })
    ) {
      this.invalidateActivity(state, target);
      return undefined;
    }
    await this.waitForTransientCaptureRetry(state, runtime, target);
    if (this.getPumpMode(state, target) === "stopped") return undefined;
    return { pending: this.captureOnce(state, target) };
  }

  private async captureOnce(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<CaptureProbeOutcome> {
    const targets = this.resolveActivityTargets(state.windowId, state.webContentsId);
    if (!targets) return CAPTURE_PROBE_FATAL;
    try {
      await targets[target].capturePage(ACTIVITY_CAPTURE_RECT);
      return CAPTURE_PROBE_SUCCEEDED;
    } catch (error) {
      this.options.log?.(
        `[browser-screenshot-activity] capture failed target=${target} windowId=${state.windowId} webContentsId=${state.webContentsId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return isTransientScreenshotCaptureError(error)
        ? CAPTURE_PROBE_TRANSIENT
        : CAPTURE_PROBE_FATAL;
    }
  }

  private createTransientRetry(): DesktopBrowserScreenshotTransientRetry {
    return new DesktopBrowserScreenshotTransientRetry({ log: this.options.log });
  }

  private ensureCapturePumps(state: ScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return;
    this.ensureCapturePump(state, "owner");
    this.ensureCapturePump(state, "guest");
  }

  private ensureCapturePump(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    const runtime = state.pumps[target];
    if (runtime.running || this.getPumpMode(state, target) === "stopped") return;
    void this.runCapturePump(state, target);
  }

  private getPumpMode(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): "continuous" | "paced" | "stopped" {
    if (!state.active || state.tokens.size === 0) return "stopped";
    const preparing = Array.from(state.tokens.values()).some((token) => !token.prepared);
    if (preparing) return "continuous";
    return target === "guest" ? "paced" : "stopped";
  }

  private async waitForGuestCaptureSlot(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    captureStartedAt: number,
  ): Promise<void> {
    const remainingMs = Math.max(
      0,
      CAPTURING_GUEST_MIN_INTERVAL_MS - (Date.now() - captureStartedAt),
    );
    if (remainingMs === 0 || this.getPumpMode(state, "guest") !== "paced") return;
    await this.waitForPumpTurn(runtime, remainingMs);
  }

  private async waitForContinuousCaptureTurn(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) !== "continuous") return;
    await this.waitForPumpTurn(runtime, 0);
  }

  private async waitForTransientCaptureRetry(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) === "stopped") return;
    await this.waitForPumpTurn(runtime, runtime.transientRetry.retryDelayMs());
  }

  /** Bounded wait that wakeCapturePumps can interrupt; the pump must yield to the main event loop before each new round. */
  private waitForPumpTurn(runtime: CapturePumpRuntime, delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runtime.wakeDelay === finish) runtime.wakeDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      runtime.wakeDelay = finish;
    });
  }

  private wakeCapturePumps(state: ScreenshotActivityState): void {
    state.pumps.owner.wakeDelay?.();
    state.pumps.guest.wakeDelay?.();
  }

  private invalidateActivity(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    if (!state.active || state.tokens.size === 0) return;
    state.active = false;
    this.releaseTransparentWindowBootstrap(state);
    this.wakeCapturePumps(state);
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key);
    }
    if (!state.invalidationController.signal.aborted) {
      // Stopping the pump alone is insufficient: the coordinator would still see its lease as valid
      // and wait for the full surface-preparation timeout. Invalidate it explicitly so preparation
      // fails immediately and late screenshots are also rejected after Ready.
      state.invalidationController.abort(
        new Error(`browser screenshot activity capture failed for ${target}`),
      );
    }
  }

  private resolveActivityTargets(
    windowId: number,
    webContentsId: number,
  ):
    | {
        window: BrowserWindowForActivity;
        owner: BrowserWindowForActivity["webContents"];
        guest: GuestWebContentsForActivity;
      }
    | undefined {
    const win = this.options.fromId(windowId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined;
    const guest = this.options.fromWebContentsId(webContentsId);
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.id !== webContentsId ||
      guest.hostWebContents?.id !== win.webContents.id
    ) {
      return undefined;
    }
    return { window: win, owner: win.webContents, guest };
  }

  private releaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (state.capturePumpStartTimer) {
      clearTimeout(state.capturePumpStartTimer);
      state.capturePumpStartTimer = undefined;
    }
    state.transparentWindowBootstrap?.release();
    state.transparentWindowBootstrap = undefined;
  }

  private scheduleCapturePumpsAfterTransparentBootstrap(state: ScreenshotActivityState): void {
    if (!state.transparentWindowBootstrap) return;
    state.capturePumpStartTimer = setTimeout(() => {
      state.capturePumpStartTimer = undefined;
      if (!state.active || this.states.get(state.key) !== state) return;
      state.capturePumpsAllowed = true;
      // Concurrent CopyFromSurface in the same turn as showInactive can reach Viz before its surface
      // is ready, causing UnknownVizError; real smoke testing has even triggered SIGSEGV. Give the
      // window a bounded presentation grace before starting the capturer. If the renderer is already
      // Ready, start only the guest's paced pump.
      this.ensureCapturePumps(state);
      this.maybeReleaseTransparentWindowBootstrap(state);
    }, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS);
  }

  private maybeReleaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (
      !state.capturePumpsAllowed ||
      Array.from(state.tokens.values()).some((candidate) => !candidate.prepared)
    ) {
      return;
    }
    this.releaseTransparentWindowBootstrap(state);
  }

  private getStateKey(windowId: number, webContentsId: number): string {
    return `${windowId}:${webContentsId}`;
  }
}
