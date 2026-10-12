/**
 * Total size limit for a single `resources/read` result initiated by the page
 * (`mcp/uiReadResource`), plus the mimeType allowlist.
 * An allowlist entry ending in `/` means prefix matching (e.g. `text/`); otherwise it is an exact
 * match (parameters and case ignored).
 */
export const MCP_APPS_UI_READ_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
// The original list omitted common resources such as PDF, so a plugin that had completed the
// handshake still could not read files; extended by explicit MIME types, keeping the
// deny-unknown-types rule.
export const MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST: readonly string[] = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  // Documents and office files.
  "application/pdf",
  "application/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // Images.
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/heic",
  "image/heif",
  // Audio and video.
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/mpeg",
  // Archives, fonts, and models: content is transferred as-is; the plugin decides how to use it.
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "model/gltf+json",
  "model/gltf-binary",
  "application/octet-stream",
];
export function isMcpAppsUiReadResourceMimeAllowed(mimeType: string): boolean {
  const essence = mimeType.split(";")[0]!.trim().toLowerCase();
  if (!essence) return false;
  return MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST.some((entry) =>
    entry.endsWith("/") ? essence.startsWith(entry) : essence === entry,
  );
}
