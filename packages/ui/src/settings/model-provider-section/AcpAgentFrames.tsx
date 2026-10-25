/**
 * Collapsible raw JSON-RPC frame log for an ACP agent test roundtrip.
 */
import type { AcpFrameEvent } from "@zcode/services";

function formatDelta(frame: AcpFrameEvent, previous: AcpFrameEvent | undefined): string {
  if (!previous) return "0ms";
  return `+${Math.max(0, frame.at - previous.at)}ms`;
}

export function AcpAgentFrames({
  frames,
  dropped,
  title,
  droppedLabel,
}: {
  frames: readonly AcpFrameEvent[];
  dropped: number;
  title: string;
  droppedLabel: string;
}) {
  if (frames.length === 0) return null;
  return (
    <details className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <summary className="cursor-pointer select-none text-ui-sm text-foreground-subtle">
        {title}
      </summary>
      {dropped > 0 ? (
        <p className="mt-1 text-ui-sm text-foreground-subtle">{droppedLabel}</p>
      ) : null}
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto font-mono text-ui-sm leading-5">
        {frames.map((frame, index) => (
          <li key={index} className="whitespace-pre-wrap break-all">
            <span className="sr-only">{frame.direction} </span>
            <span aria-hidden="true" className="text-foreground-subtle">
              {frame.direction === "out" ? "→ " : "← "}
            </span>
            <span className="text-foreground-subtle">{formatDelta(frame, frames[index - 1])} </span>
            <span>{frame.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
