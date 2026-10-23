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
  // Round at each unit's precision before choosing the unit, so 59_960 never prints as "60.0s".
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  const hundredths = Math.round(ms / 10);
  if (hundredths < 1000) return `${(hundredths / 100).toFixed(2)}s`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
