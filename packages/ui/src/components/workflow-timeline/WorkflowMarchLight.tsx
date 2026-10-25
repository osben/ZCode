/**
 * Light for the moving edge: the edge control flow used to enter a running station.
 * Overlay a 1.5px round-capped SVG path with a `userSpaceOnUse` gradient stroke, from transparent at the start to full warning color at 80%.
 * It is brightest near the light and fades toward the control-flow source, as if the light illuminated the path it traveled.
 * It does not move: the edge describes the past (control flow traversed it); motion belongs to the running light (`wf-lamp-running` pulse).
 * Previously, a warning-colored dashed line moved along the path, suggesting it was still traveling from the previous station.
 *
 * The gradient runs along x (the x-coordinates of the path endpoints); that is sufficient because timeline arcs, fork, and merge curves
 * are horizontal except for two short vertical segments. If endpoint x-coordinates match (not expected on the spine, but guard it), run along y instead.
 * The caller supplies `id`, which must be unique within the SVG.
 */
export interface MarchLightProps {
  /** Path to light; arcs provide the path shortened by 6px to stop at the arrow base. */
  d: string;
  /** Path start (the control-flow source). */
  from: { x: number; y: number };
  /** Path end (the running light's side). */
  to: { x: number; y: number };
  id: string;
}

export function MarchLight({ d, from, id, to }: MarchLightProps) {
  const alongY = from.x === to.x;
  return (
    <>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1={alongY ? 0 : from.x}
          x2={alongY ? 0 : to.x}
          y1={alongY ? from.y : 0}
          y2={alongY ? to.y : 0}
        >
          <stop offset={0} stopColor="var(--color-warning)" stopOpacity={0} />
          <stop offset={0.8} stopColor="var(--color-warning)" />
        </linearGradient>
      </defs>
      <path
        className="wf-lit"
        d={d}
        data-testid="workflow-march-light"
        fill="none"
        stroke={`url(#${id})`}
      />
    </>
  );
}
