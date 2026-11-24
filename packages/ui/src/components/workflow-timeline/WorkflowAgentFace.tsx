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

export type AgentResult = "completed" | "stopped" | "failed";

/** 面板和胶囊共用同一坐标，避免两套徽标出现位置、底色和尺寸差异。 */
export function AgentResultBadge({ result }: { result: AgentResult }) {
  const fill =
    result === "completed"
      ? "var(--color-success)"
      : result === "failed"
        ? "var(--color-destructive)"
        : "var(--color-foreground-subtle)";
  const foreground =
    result === "completed"
      ? "var(--color-success-foreground)"
      : result === "failed"
        ? "var(--color-destructive-foreground)"
        : "var(--color-background)";
  return (
    <g
      data-agent-result-badge={result}
      data-subagent-completion-badge={result === "completed" ? "" : undefined}
    >
      {/* 次要前景 token 含透明度；先垫背景，避免灰底透出头像颜色。 */}
      <circle cx={3} cy={17} r={5.5} fill="var(--color-background)" />
      <circle
        cx={3}
        cy={17}
        r={5.5}
        fill={fill}
        stroke="var(--color-background)"
        strokeWidth={1.5}
      />
      {result === "completed" ? (
        <path
          d="m0.5 17 1.7 1.7 3.3-3.4"
          fill="none"
          stroke={foreground}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : result === "stopped" ? (
        <rect x={1} y={15} width={4} height={4} rx={0.5} fill={foreground} />
      ) : (
        <g fill={foreground}>
          <rect x={2.25} y={13.7} width={1.5} height={4} rx={0.75} />
          <circle cx={3} cy={19.4} r={0.8} />
        </g>
      )}
    </g>
  );
}

export function WorkflowAgentFace({
  avatarIndex,
  className,
  name,
  status,
  idle = false,
  motionPaused = false,
  showCompletionMark = false,
  result,
  color,
  outlineColor,
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
  idle?: boolean;
  motionPaused?: boolean;
  showCompletionMark?: boolean;
  result?: AgentResult;
  color?: string;
  outlineColor?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const badgeResult = result ?? (showCompletionMark ? "completed" : undefined);
  const state = idle ? "idle" : faceState(status);
  useEffect(() => {
    const face = ref.current;
    if (!face) return;
    if (!badgeResult && !motionPaused) return startFaceMotion(face, state);
    // 旧动画 cleanup 会写回旧表情；静止态必须在清理后恢复当前结果，避免结束后仍显示运行/等待脸。
    face.dataset.expression = BASE_EXPRESSION[state];
    face.dataset.motion = "idle";
    face.style.removeProperty("--wf-face-x");
    face.style.removeProperty("--wf-face-y");
  }, [state, badgeResult, motionPaused]);
  const style = { "--wf-face-body": color ?? agentColor(avatarIndex, name) } as CSSProperties;
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
      {/* CSS ring 的圆角与 SVG 本体不同；描边复用本体路径，先画线再填充以保留 1px 外沿。 */}
      <rect
        className="wf-face-body"
        fill="var(--wf-face-body)"
        height={20}
        rx={7}
        width={20}
        stroke={outlineColor}
        strokeWidth={outlineColor ? 2 : undefined}
        paintOrder="stroke fill"
        vectorEffect="non-scaling-stroke"
      />
      <Eyes />
      {badgeResult ? <AgentResultBadge result={badgeResult} /> : null}
    </svg>
  );
}

/** 集合入口不代表单个代理，使用同款静态中性头像。 */
export function SubagentCollectionIcon({ className }: { className?: string }) {
  return (
    <WorkflowAgentFace
      avatarIndex={undefined}
      name=""
      status={undefined}
      idle
      color="var(--color-foreground-subtle)"
      className={className}
    />
  );
}
