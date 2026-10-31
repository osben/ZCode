import { constants } from "node:os";
import { Emitter, type Event } from "@zcode/rpc";

interface CloseEventController {
  event: Event<number>;
  fire(code: number): void;
}

export function createCloseEventController(): CloseEventController {
  const emitter = new Emitter<number>();
  let closed = false;
  let closeCode = 0;

  const event: Event<number> = (listener) => {
    // A remote command may exit immediately before the caller subscribes to onClose.
    // If the event is only delivered live with no replay, waitForClose can wait forever and the connection appears stuck.
    // Replay the last close code to late subscribers to avoid losing the event in this race.
    if (closed) {
      queueMicrotask(() => {
        listener(closeCode);
      });
      return { dispose() {} };
    }

    return emitter.event(listener);
  };

  const fire = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    closeCode = code;
    emitter.fire(code);
    emitter.dispose();
  };

  return { event, fire };
}

/** Failure value when no exit code is available; matches the OpenSSH client's exit code when it receives no exit-status. */
const UNKNOWN_REMOTE_EXIT_CODE = 255;

/**
 * Normalize child_process / ssh2 exit arguments into a single exit code.
 *
 * Bug cause: all three Backends wrote `code ?? 0`. When a process is killed by a signal, code is
 * null, and an ssh2 channel close without exit-status also carries no code — so downloads,
 * unpacks, and updates killed with kill -9 were all treated as successful. Per shell convention
 * this returns 128 + signal; with no exit information at all it returns 255.
 */
export function resolveRemoteExitCode(
  code: number | null | undefined,
  signal: string | null | undefined,
): number {
  if (typeof code === "number") {
    return code;
  }
  const signalNumber = signal
    ? constants.signals[signal as keyof typeof constants.signals]
    : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : UNKNOWN_REMOTE_EXIT_CODE;
}
