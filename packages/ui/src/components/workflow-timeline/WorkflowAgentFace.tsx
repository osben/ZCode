import { useEffect, useRef, type CSSProperties } from "react";
import {
  BASE_EXPRESSION,
  faceState,
  startFaceMotion,
} from "@/components/workflow-timeline/workflow-face-motion.js";
export { faceState } from "@/components/workflow-timeline/workflow-face-motion.js";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * Tile face: an application-icon rounded square without the Z, with two eyes added.
 * It is the subagent avatar shared by pills, roster cells, and collapsed sidebar avatar groups.
 *
 * Identity is encoded by body color: choose from nine fixed HEX colors by `avatarIndex`, cycling after nine; without an index, fall back to a name hash.
 * Status determines the base expression; independent random motions update only SVG attributes.
 */
export const FACE_COLORS = [
  "#54B9A6",
  "#F19D38",
  "#6464EF",
  "#885CF5",
  "#3C82F6",
  "#ED712E",
  "#EB4699",
  "#5BC67A",
  "#EA4045",
] as const;

/** Choose a color from a name hash (base-31 modulo 360, then mapped to the nine-color palette); used only when `avatarIndex` is absent. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return FACE_COLORS[hash % FACE_COLORS.length]!;
}

/** Agent color: prefer the index (cycling through nine colors), falling back to the name hash. Pill hover border and face share this color. */
export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name);
  return FACE_COLORS[
    ((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length
  ]!;
}

const EXPRESSIONS = ["pill", "happy", "sleepy", "focused", "sad", "confused"] as const;

// Draw reference eye shapes directly in the 20-cell grid; share left/right start points to keep the baseline and gaze aligned when changing expressions.
function Eyes() {
  return (
    <g className="wf-face-eyes">
      <g className="wf-face-bounce">
        <g className="wf-face-lids">
          <g data-eye-expression="dots" fill="var(--wf-face-eye)">
            {[5, 10, 15].map((cx) => (
              <circle key={cx} cx={cx} cy={10} r={1.5} />
            ))}
          </g>
          {EXPRESSIONS.map((expression) => (
            <g key={expression} data-eye-expression={expression} fill="var(--wf-face-eye)">
              {[7, 13].map((x, i) => {
                if (expression === "pill" || expression === "confused") {
                  const short = expression === "confused" && i === 1;
                  return (
                    <rect key={x} x={x} y={short ? 8 : 6} width={4} height={short ? 4 : 6} rx={2} />
                  );
                }
                const paths = {
                  happy: "M0 11 V8 A2 2 0 0 1 4 8 V11 Z",
                  sleepy:
                    i === 0 ? "M0 8 L4 7 V9 A2 2 0 0 1 0 9 Z" : "M0 7 L4 8 V9 A2 2 0 0 1 0 9 Z",
                  focused:
                    i === 0 ? "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z" : "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z",
                  sad:
                    i === 0 ? "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z" : "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z",
                };
                return <path key={x} transform={`translate(${x} 0)`} d={paths[expression]} />;
              })}
            </g>
          ))}
        </g>
        {/* Draw closed eyes as a separate horizontal capsule so vertical scaling does not flatten the rounded ends into thin lines. */}
        <g className="wf-face-closed" fill="var(--wf-face-eye)">
          {[7, 13].map((x) => (
            <rect key={x} x={x} y={8} width={4} height={2} rx={1} />
          ))}
        </g>
      </g>
    </g>
  );
}

export function WorkflowAgentFace({
  avatarIndex,
  className,
  name,
  status,
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const state = faceState(status);
  useEffect(() => {
    if (ref.current) return startFaceMotion(ref.current, state);
  }, [state]);
  const style = { "--wf-face-body": agentColor(avatarIndex, name) } as CSSProperties;
  return (
    <svg
      aria-hidden
      className={cn("wf-face overflow-visible", className)}
      data-face-state={state}
      data-expression={BASE_EXPRESSION[state]}
      data-motion="idle"
      data-subagent-avatar
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      <rect className="wf-face-body" fill="var(--wf-face-body)" height={20} rx={7} width={20} />
      <Eyes />
    </svg>
  );
}
