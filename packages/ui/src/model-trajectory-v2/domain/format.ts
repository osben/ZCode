const PREVIEW_CHARS = 240;

function oneLine(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Compact one-line JSON (or text) for ledger rows. */
export function payloadPreview(value: unknown, max = PREVIEW_CHARS): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return oneLine(value, max);
  const object = value as { type?: unknown; value?: unknown; content?: unknown };
  if (object.type === "error-text" && typeof object.value === "string")
    return oneLine(object.value, max);
  if (typeof object.content === "string") return oneLine(object.content, max);
  try {
    return oneLine(JSON.stringify(value) ?? "", max);
  } catch {
    return "";
  }
}

export function textPreview(text: string | undefined, max = PREVIEW_CHARS): string {
  return text ? oneLine(text, max) : "";
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  return tokens.toLocaleString("en-US");
}

export function formatClock(epochMs: number | undefined): string {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return "—";
  const date = new Date(epochMs);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Pretty JSON for inspector payloads; strings stay as they are. */
export function prettyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
