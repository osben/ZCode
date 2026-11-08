import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_REF_NOT_AUTHORIZED,
  editAttachmentsToSubmit,
  isAttachmentRefNotAuthorizedError,
} from "./contract.js";

// specs/fork-attachment-ref-trust-boundary.md
describe("isAttachmentRefNotAuthorizedError", () => {
  it("recognizes the refusal code, including when a bridge prefixes the message", () => {
    expect(isAttachmentRefNotAuthorizedError(new Error(ATTACHMENT_REF_NOT_AUTHORIZED))).toBe(true);
    expect(
      isAttachmentRefNotAuthorizedError(
        new Error(`Error invoking remote method: Error: ${ATTACHMENT_REF_NOT_AUTHORIZED}`),
      ),
    ).toBe(true);
    expect(isAttachmentRefNotAuthorizedError(ATTACHMENT_REF_NOT_AUTHORIZED)).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isAttachmentRefNotAuthorizedError(new Error("proto.invalidPayload"))).toBe(false);
    expect(isAttachmentRefNotAuthorizedError(undefined)).toBe(false);
    expect(isAttachmentRefNotAuthorizedError({ message: ATTACHMENT_REF_NOT_AUTHORIZED })).toBe(
      false,
    );
  });
});

describe("editAttachmentsToSubmit", () => {
  const desktopPath = { ref: "/Users/someone/Documents/picked.pdf", fileName: "picked.pdf" };
  const parentArtifact = { ref: "zcode-artifact://sess_parent/tool-result-1", fileName: "a.txt" };

  it("omits an untouched list so the agent keeps the canonical refs", () => {
    const original = [desktopPath, parentArtifact];
    expect(editAttachmentsToSubmit(original, [...original])).toBeUndefined();
    // A re-rendered projection carries new objects with the same refs.
    expect(
      editAttachmentsToSubmit(original, [{ ...desktopPath }, { ...parentArtifact }]),
    ).toBeUndefined();
    expect(editAttachmentsToSubmit(undefined, [])).toBeUndefined();
  });

  it("sends the full remaining list after a removal", () => {
    expect(editAttachmentsToSubmit([desktopPath, parentArtifact], [parentArtifact])).toEqual([
      parentArtifact,
    ]);
  });

  it("sends an explicit [] when every attachment was removed", () => {
    expect(editAttachmentsToSubmit([desktopPath], [])).toEqual([]);
  });
});
