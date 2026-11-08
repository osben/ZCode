import { ATTACHMENT_REF_NOT_AUTHORIZED } from "@zcode/shared/fork-attachment-ref-trust";

export { ATTACHMENT_REF_NOT_AUTHORIZED };

export type AttachmentRefRefusalReason =
  | "local_path"
  | "foreign_scheme"
  | "foreign_session"
  | "malformed_artifact"
  | "no_session";

export interface AttachmentRefRefusal {
  code: typeof ATTACHMENT_REF_NOT_AUTHORIZED;
  commandType: string;
  reason: AttachmentRefRefusalReason;
}

interface CommandEnvelopeLike {
  type: string;
  sessionId?: string | null;
  payload: unknown;
}

const ARTIFACT_PREFIX = "zcode-artifact://";
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Ref strings (`ref` and `previewRef`) of the attachment-carrying fields of a v4 command. */
function commandAttachmentRefStrings(envelope: CommandEnvelopeLike): string[] {
  const payload = asRecord(envelope.payload);
  if (!payload) return [];
  let attachments: unknown;
  if (envelope.type === "sendText" || envelope.type === "editUserQuery") {
    attachments = payload.attachments;
  } else if (envelope.type === "createSession") {
    attachments = asRecord(payload.firstInput)?.attachments;
  } else {
    return [];
  }
  if (!Array.isArray(attachments)) return [];
  const refs: string[] = [];
  for (const attachment of attachments) {
    const record = asRecord(attachment);
    if (!record) continue;
    // Schema validation downstream rejects non-string refs; only strings can name a file.
    if (typeof record.ref === "string") refs.push(record.ref);
    if (typeof record.previewRef === "string") refs.push(record.previewRef);
  }
  return refs;
}

function mobileRefRefusal(
  ref: string,
  sessionId: string | undefined,
): AttachmentRefRefusalReason | undefined {
  if (!ref.startsWith(ARTIFACT_PREFIX)) {
    return URI_SCHEME_PATTERN.test(ref) ? "foreign_scheme" : "local_path";
  }
  if (!sessionId) return "no_session";
  const rest = ref.slice(ARTIFACT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return "malformed_artifact";
  // Compare the canonical encoded form the artifact store emits, so userinfo, ports or alternate
  // encodings cannot make a URL parser resolve a different session than the one compared here.
  if (rest.slice(0, slash) !== encodeURIComponent(sessionId)) return "foreign_session";
  const id = rest.slice(slash + 1);
  if (!ARTIFACT_ID_PATTERN.test(id) || id === "." || id === "..") return "malformed_artifact";
  return undefined;
}

/**
 * Host admission of attachment refs (specs/fork-attachment-ref-trust-boundary.md).
 * Desktop origin admits every ref; a web-remote (mobile) origin may only reference artifacts of the
 * command's own session, because any other string would make the agent read a Host file.
 */
export function attachmentRefAdmissionError(
  envelope: CommandEnvelopeLike,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): AttachmentRefRefusal | undefined {
  if (clientMode !== "web-remote-replayable") return undefined;
  const sessionId = envelope.sessionId?.trim() ? envelope.sessionId : undefined;
  for (const ref of commandAttachmentRefStrings(envelope)) {
    const reason = mobileRefRefusal(ref, sessionId);
    if (reason) {
      return { code: ATTACHMENT_REF_NOT_AUTHORIZED, commandType: envelope.type, reason };
    }
  }
  return undefined;
}
