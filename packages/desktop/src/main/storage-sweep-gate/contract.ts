/**
 * Main-side gate for the reservation placeholder startup sweep (specs/first-submission-lifecycle.md, "Placeholder startup sweep").
 * The first local Host claimed in an app process carries sweepAbandonedReservations. Every later local InitLocal waits until that
 * Host reports its startup ready or failed, or its process exits. There is no timer: the Host's own startup status timeout produces
 * the terminal state.
 */
export interface LocalHostStartupTicket {
  readonly sweepAbandonedReservations: boolean;
  /** Resolves when this Host's InitLocal may be posted. */
  readonly open: Promise<void>;
  /** Reports the claimed Host's terminal startup state or exit. A no-op for every other ticket. */
  settle(): void;
}

export interface LocalHostStartupGate {
  claim(): LocalHostStartupTicket;
}

export function createLocalHostStartupGate(): LocalHostStartupGate {
  let claimed = false;
  let releaseWaiters: () => void = () => {};
  const firstSettled = new Promise<void>((resolve) => {
    releaseWaiters = resolve;
  });
  return {
    claim: () => {
      if (claimed) {
        return { sweepAbandonedReservations: false, open: firstSettled, settle: () => {} };
      }
      claimed = true;
      let settled = false;
      return {
        sweepAbandonedReservations: true,
        open: Promise.resolve(),
        settle: () => {
          if (settled) return;
          settled = true;
          releaseWaiters();
        },
      };
    },
  };
}
