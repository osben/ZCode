/**
 * fork-attachment-ref-trust usage: the Host checks a command before forwarding it to the agent.
 */
import { attachmentRefAdmissionError } from "./contract.js";

export function exampleAttachmentRefAdmission(
  envelope: { type: string; sessionId?: string | null; payload: unknown },
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const refusal = attachmentRefAdmissionError(envelope, clientMode);
  if (refusal) throw new Error(refusal.code);
}
