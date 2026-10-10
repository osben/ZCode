import { createHash } from "node:crypto";

import {
  conversationShareConfirmRequestSchema,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
} from "@zcode/shared";

type ConversationShareConfirmRequestBase = Omit<ConversationShareConfirmRequest, "integrity"> & {
  artifacts: ConversationShareArtifactDescriptor[];
};

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Conversation share JSON contains invalid Unicode");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Conversation share JSON contains invalid Unicode");
    }
  }
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Conversation share JSON numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          assertValidUnicode(key);
          const entry = record[key];
          if (entry === undefined) {
            throw new TypeError("Conversation share JSON cannot contain undefined values");
          }
          return `${JSON.stringify(key)}:${canonicalizeValue(entry)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Conversation share JSON cannot contain ${typeof value}`);
  }
}

function canonicalizeConversationShareJson(value: unknown): string {
  return canonicalizeValue(value);
}

export function sha256ConversationShareJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeConversationShareJson(value), "utf8")
    .digest("hex");
}

export function buildConversationShareConfirmRequest(
  input: ConversationShareConfirmRequestBase,
): ConversationShareConfirmRequest {
  const artifacts = [...input.artifacts].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id),
  );
  const projectionSha256 = sha256ConversationShareJson(input.projection.rows);
  const artifactSetSha256 = sha256ConversationShareJson(artifacts);
  const { artifacts: _artifacts, ...confirmRequest } = input;

  return conversationShareConfirmRequestSchema.parse({
    ...confirmRequest,
    integrity: {
      projection_sha256: projectionSha256,
      artifact_set_sha256: artifactSetSha256,
    },
  });
}

/**
 * Fields added only when the server issues signed URLs; excluded from the artifact-set digest.
 *
 * This list contains "fields added by the server when reading," not a whitelist of "fields known by this client"; those have opposite meanings.
 * The former handles version skew correctly:
 * - If a newer publisher adds a descriptor field, it is stored on the server and included in the server-computed digest;
 *   an older importer also includes it when hashing the raw value, so the hashes match (the behavior we need to preserve).
 * - If instead the value is projected onto fields known by this client, the new field is removed and the hashes immediately differ.
 *
 * Tradeoff: if the server later adds a field to read responses (rather than echoing uploaded content), it must also be added to this list,
 * or the digest will differ. That would violate the server's revision contract (continuation integrity is defined over the
 * descriptor set); the symptom is clear and the fix is to add the key here.
 */
const ARTIFACT_URL_KEYS = ["download_url", "download_url_expires_at", "url", "url_expires_at"];

function artifactIdOf(value: unknown): string {
  const id = (value as { artifact_id?: unknown } | null)?.artifact_id;
  return typeof id === "string" ? id : "";
}

function stripArtifactUrls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stripped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ARTIFACT_URL_KEYS) delete stripped[key];
  return stripped;
}

/**
 * Recheck both digests using the rows/artifacts **exactly as returned by the server**.
 *
 * The key is to use the raw value: this previously used Zod's parsed output, which strips unknown fields by default. If a publisher
 * added an optional field to a row, an older importer would necessarily recalculate a different hash and show a "share file validation
 * failed" warning that looked like tampering, plus a retry button that could never succeed.
 *
 * Validating the raw values decouples integrity from schema knowledge: the schema can evolve additively,
 * and a hash mismatch once again means what it should—content was actually changed or corrupted.
 */
export function verifyConversationShareIntegrity(input: {
  rawRows: unknown;
  rawArtifacts: unknown;
  integrity: { projection_sha256: string; artifact_set_sha256: string };
}): boolean {
  const artifacts = Array.isArray(input.rawArtifacts)
    ? [...(input.rawArtifacts as unknown[])]
        .sort((left, right) => artifactIdOf(left).localeCompare(artifactIdOf(right)))
        .map(stripArtifactUrls)
    : input.rawArtifacts;
  return (
    sha256ConversationShareJson(input.rawRows) === input.integrity.projection_sha256 &&
    sha256ConversationShareJson(artifacts) === input.integrity.artifact_set_sha256
  );
}
