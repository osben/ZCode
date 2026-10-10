export function getErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  // Some remote-connection errors already include the "Error: ..." prefix,
  // so wrapping them again as Error or displaying String(error) adds another prefix: "Error: Error: ...".
  // Strip duplicate prefixes consistently here and keep only the meaningful error content.
  return rawMessage.replace(/^(Error:\s*)+/i, "").trim();
}
