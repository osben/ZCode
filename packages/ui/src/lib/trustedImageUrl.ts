/** Remote images in the UI are allowed only over HTTPS; display components fall back to local icons on failure. */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}
