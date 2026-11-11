// Fork: the size and media type Share's attachment stat reports for a prompt attachment held in a session artifact
// (specs/fork-agent-runtime-selection.md, "Share reads"). The artifact holds `data:<mime>;base64,<payload>` as text, so
// stating the stored object reported the encoded data URL's length and `text/plain`, while the read served the decoded
// bytes and the data URL's media type.

/**
 * The decoded length and media type of a prompt attachment's data URL, computed without decoding it, matching what
 * `decodePromptAttachmentDataUrl` serves. `undefined` when the content is not a strict base64 data URL.
 */
export function statPromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
): { totalBytes: number; mediaType: string } | undefined {
  const commaIndex = content.indexOf(",");
  if (content.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = content.slice("data:".length, commaIndex).split(";");
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = content.slice(commaIndex + 1);
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    return undefined;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return { totalBytes: (payload.length / 4) * 3 - padding, mediaType };
}
