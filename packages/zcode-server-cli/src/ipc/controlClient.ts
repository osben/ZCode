import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE } from "@zcode/shared";
import { controlResponseSchema, type ControlRequest } from "../contracts.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

// Omit does not distribute over unions: directly applying Omit<ControlRequest, "id"> drops variant fields such as confirmation/force,
// preventing callers from constructing valid requests as literals. Use distributive Omit to preserve each command's full shape.
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ControlRequestInput = DistributedOmit<ControlRequest, "id">;

export async function requestControl(
  endpoint: string,
  request: ControlRequestInput,
  timeoutMs = 10_000,
): Promise<unknown> {
  const id = randomUUID();
  const socket = connect(endpoint);
  const decoder = new JsonLineDecoder();
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      // A timeout means the Supervisor accepted the connection but stopped responding; the public
      // code makes the desktop show "remote service unresponsive" instead of it being classified
      // as a connection timeout by message text. The CLI does not force-kill the Supervisor here (R2 §8.1).
      reject(
        new ControlRequestError(
          SOURCE_SERVER_CONTROL_UNRESPONSIVE_ERROR_CODE,
          "Supervisor control request timed out",
        ),
      );
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk: string) => {
      try {
        const response = decoder.push(chunk)[0];
        if (response === undefined) return;
        const parsed = controlResponseSchema.parse(response);
        if (parsed.id !== id) return;
        clearTimeout(timeout);
        socket.end();
        if (parsed.ok) resolve(parsed.result);
        else
          reject(
            new ControlRequestError(
              parsed.error?.code ?? "request-failed",
              parsed.error?.message ?? "Supervisor request failed",
              parsed.error?.retryable,
            ),
          );
      } catch (error) {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      }
    });
    socket.on("connect", () => socket.write(encodeJsonLine({ ...request, id })));
  });
}

/**
 * Whether `requestControl` failed because the control endpoint does not exist or nobody is
 * listening (missing socket file, connection refused, invalid Windows named pipe). Expresses only
 * "no Supervisor answering", not the timeout of a connection that was accepted but unresponsive.
 */
export function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL";
}
