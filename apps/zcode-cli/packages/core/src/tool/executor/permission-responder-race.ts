// Race the PermissionRequest hook chain against the interaction broker.
//
// The old path awaited the hook chain after emitPermissionRequested, and registered the
// broker's response deferred only after the hook returned. While a synchronous hook
// (for example, a bridge that forwards the request to an external UI and waits for a
// click) was suspended, the dialog was already visible but resolveInteraction silently
// discarded every click as an idempotent success for an unknown request. The dialog and
// turn then remained stuck forever. Start both responders concurrently, apply the first
// decision, and abort the loser without waiting for it.
import type { PermissionBrokerResult } from "@zcode/contracts";
import { linkAbortSignal } from "./timeout.js";

export interface PermissionResponderRaceInput {
  /**
   * Hook-chain responder. Resolving to `undefined` means no decision (it withdraws,
   * leaving the broker to wait alone). Rejection also counts as withdrawal and invokes
   * {@link PermissionResponderRaceInput.onHookFailure}; infrastructure failure in an
   * auxiliary responder must not decide for the user.
   */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /**
   * Broker responder. The response channel (v4 interaction deferred / TUI approval
   * queue) must be established synchronously inside this function; the existing broker
   * contract guarantees this, and it is required for a visible dialog to be answerable.
   * If the hook has not won, propagate rejection (timeout, cancellation, fail-closed)
   * unchanged, matching the old serial path's error behavior.
   */
  requestBroker: (
    signal: AbortSignal,
    claimResponse: () => boolean,
  ) => Promise<PermissionBrokerResult>;
  /** Outer-turn cancellation signal: abort both responders, then propagate the broker rejection as described above. */
  signal?: AbortSignal;
  /** Called when the hook chain rejects before the race settles (the caller logs a warning). */
  onHookFailure?: (error: unknown) => void;
}

export interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}

export async function racePermissionResponders(
  input: PermissionResponderRaceInput,
): Promise<PermissionResponderRaceOutcome> {
  const hookController = new AbortController();
  const brokerController = new AbortController();
  const unlinkHook = linkAbortSignal(input.signal, hookController);
  const unlinkBroker = linkAbortSignal(input.signal, brokerController);

  let settled = false;
  let brokerClaimed = false;
  try {
    return await new Promise<PermissionResponderRaceOutcome>((resolve, reject) => {
      const settle = (action: () => void, abortLoser: AbortController) => {
        if (settled) return;
        settled = true;
        action();
        // Resolve the result before aborting the loser: loser cleanup (child-process
        // termination or reverse-RPC cancellation) must not block the winner. The loser
        // itself may be stuck.
        abortLoser.abort();
      };

      // Start the broker first: requestPermission synchronously registers the response
      // deferred, so every click has a destination as soon as the dialog is visible and
      // the hook gets no exclusive window.
      input
        .requestBroker(brokerController.signal, () => {
          if (settled || brokerController.signal.aborted) return false;
          brokerClaimed = true;
          hookController.abort();
          return true;
        })
        .then(
          (result) => settle(() => resolve({ result, source: "broker" }), hookController),
          (error) => {
            // After the hook wins, a broker rejection caused by our abort is expected
            // cancellation and is ignored. A rejection before the race settles
            // (timeout/outer cancellation/fail-closed) is real and is propagated.
            settle(() => reject(error), hookController);
          },
        );

      input.runHooks(hookController.signal).then(
        (decision) => {
          // No decision means withdrawal: leave the race state unchanged and let the broker continue waiting alone.
          if (decision === undefined || brokerClaimed) return;
          settle(() => resolve({ result: decision, source: "hook" }), brokerController);
        },
        (error) => {
          if (settled) return;
          input.onHookFailure?.(error);
        },
      );
    });
  } finally {
    unlinkHook();
    unlinkBroker();
  }
}
