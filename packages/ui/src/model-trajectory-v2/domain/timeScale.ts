export interface TimeDomain {
  from: number;
  to: number;
}

export interface LaneSpan {
  key: string;
  start: number;
  end: number;
  /** TTFT end for model spans; spans without it draw solid. */
  firstTokenAt?: number;
  isError?: boolean;
}

export interface PackedSpan extends LaneSpan {
  subRow: number;
}

/** Smallest domain covering every span; a single instant widens to one second. */
export function domainOf(spans: readonly { start: number; end: number }[]): TimeDomain | null {
  if (spans.length === 0) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    from = Math.min(from, span.start);
    to = Math.max(to, span.end);
  }
  return to > from ? { from, to } : { from, to: from + 1000 };
}

export function timeToX(time: number, domain: TimeDomain, width: number): number {
  return ((time - domain.from) / (domain.to - domain.from)) * width;
}

export function xToTime(x: number, domain: TimeDomain, width: number): number {
  return domain.from + (x / Math.max(1, width)) * (domain.to - domain.from);
}

/** Greedy packing: each span takes the first sub-row whose last span ended before it starts. */
export function packLane(spans: readonly LaneSpan[]): { spans: PackedSpan[]; rows: number } {
  const rowEnds: number[] = [];
  const packed = [...spans]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((span) => {
      let subRow = rowEnds.findIndex((end) => end <= span.start);
      if (subRow === -1) {
        subRow = rowEnds.length;
        rowEnds.push(span.end);
      } else {
        rowEnds[subRow] = span.end;
      }
      return { ...span, subRow };
    });
  return { spans: packed, rows: Math.max(1, rowEnds.length) };
}

/** Zoom by `factor` (< 1 zooms in) around `anchor`, clamped to `bounds` and to a minimum width. */
export function zoomDomain(
  domain: TimeDomain,
  anchor: number,
  factor: number,
  bounds: TimeDomain,
  minWidthMs = 50,
): TimeDomain {
  const width = Math.max(minWidthMs, (domain.to - domain.from) * factor);
  const ratio = (anchor - domain.from) / (domain.to - domain.from || 1);
  return clampDomain({ from: anchor - width * ratio, to: anchor - width * ratio + width }, bounds);
}

/** Shift by `deltaMs`, keeping the width and staying inside `bounds`. */
export function panDomain(domain: TimeDomain, deltaMs: number, bounds: TimeDomain): TimeDomain {
  return clampDomain({ from: domain.from + deltaMs, to: domain.to + deltaMs }, bounds);
}

export function clampDomain(domain: TimeDomain, bounds: TimeDomain): TimeDomain {
  const width = Math.min(domain.to - domain.from, bounds.to - bounds.from);
  let from = Math.max(bounds.from, domain.from);
  if (from + width > bounds.to) from = bounds.to - width;
  return { from, to: from + width };
}

/** Normalize a drag into an ordered range clamped to `bounds`; null when it collapses to nothing. */
export function normalizeRange(a: number, b: number, bounds: TimeDomain): TimeDomain | null {
  const from = Math.max(bounds.from, Math.min(a, b));
  const to = Math.min(bounds.to, Math.max(a, b));
  return to > from ? { from, to } : null;
}

/** Up to `count` round tick times inside the domain. */
export function ticks(domain: TimeDomain, count: number): number[] {
  const span = domain.to - domain.from;
  const steps = [
    100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
    1_800_000, 3_600_000,
  ];
  const step = steps.find((candidate) => span / candidate <= count) ?? steps[steps.length - 1]!;
  const result: number[] = [];
  for (let time = Math.ceil(domain.from / step) * step; time <= domain.to; time += step)
    result.push(time);
  return result;
}
