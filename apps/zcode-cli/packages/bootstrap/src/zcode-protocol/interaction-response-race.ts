import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Race legacy reverse RPCs (interaction/requestPermission, etc.) against v4 resolveInteraction
 * commands; whichever response arrives first takes effect.
 *
 * Implementation: await the RPC as the primary path and cancel it when v4 wins:
 * - Register interactionId in v4Interactions (the business requestId, shared with the v4 projection's
 *   PendingInteraction.interactionId). When a v4 response arrives, store the answer and abort the
 *   internal controller so requestClient rejects with ProtocolRequestError(-32021).
 * - In catch, return the mapped result if a v4 answer exists (consuming the cancellation error);
 *   otherwise rethrow unchanged, including cancellation from the caller's outerSignal, to preserve
 *   legacy-path error semantics.
 * - In finally, unregister and remove the outerSignal listener. Late v4 answers are treated as misses
 *   (the resolveInteraction handler is idempotent).
 */
export async function raceClientRequestWithV4Interaction<T>(
  context: ZCodeProtocolAgentServerContext,
  interactionId: string,
  outerSignal: AbortSignal | undefined,
  startRequest: (signal: AbortSignal) => Promise<T>,
  mapAnswer: (answer: V4InteractionAnswer) => T,
  registrationOptions?: V4InteractionRegistrationOptions,
): Promise<T> {
  const controller = new AbortController();
  // Each attempt waits on its own failure notification; a successful V4 answer still releases the
  // wait through the registry. Resetting a boolean cannot wake an already-awaited legacy response,
  // while reusing a one-shot notification would let retries proceed too early.
  let fullAccessFailure: Promise<void> | undefined;
  let finishAnswer!: () => void;
  const answerReady = new Promise<void>((resolve) => {
    finishAnswer = resolve;
  });
  const forwardAbort = () => {
    controller.abort();
    finishAnswer();
  };
  if (outerSignal?.aborted) {
    controller.abort();
  } else {
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  // Use a container rather than a bare value to distinguish "the answer has an undefined field"
  // from "there is no answer yet."
  let v4Answer: { answer: V4InteractionAnswer } | undefined;
  const unregister = context.v4Interactions.register(
    interactionId,
    (answer) => {
      v4Answer = { answer };
      controller.abort();
      finishAnswer();
    },
    registrationOptions?.fullAccess
      ? {
          ...registrationOptions,
          fullAccess: async () => {
            let notifyFailure!: () => void;
            const failure = new Promise<void>((resolve) => {
              notifyFailure = resolve;
            });
            fullAccessFailure = failure;
            try {
              await registrationOptions.fullAccess!();
            } catch (error) {
              if (fullAccessFailure === failure) fullAccessFailure = undefined;
              notifyFailure();
              throw error;
            }
          },
        }
      : registrationOptions,
  );

  const waitForFullAccess = async () => {
    while (fullAccessFailure && !v4Answer && !outerSignal?.aborted) {
      await Promise.race([fullAccessFailure, answerReady]);
    }
  };

  try {
    const result = await startRequest(controller.signal);
    if (fullAccessFailure) {
      await waitForFullAccess();
      if (v4Answer) return mapAnswer(v4Answer.answer);
      outerSignal?.throwIfAborted();
    }
    return result;
  } catch (error) {
    if (fullAccessFailure) await waitForFullAccess();
    if (v4Answer) {
      return mapAnswer(v4Answer.answer);
    }
    throw error;
  } finally {
    unregister();
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}
