import {
  domainOf,
  normalizeRange,
  packLane,
  panDomain,
  ticks,
  timeToX,
  xToTime,
  zoomDomain,
} from "@/model-trajectory-v2/domain/timeScale.js";
import type { LaneSpan } from "@/model-trajectory-v2/domain/timeScale.js";
import { describe, expect, it } from "vitest";

const span = (key: string, start: number, end: number, over: Partial<LaneSpan> = {}): LaneSpan => ({
  key,
  start,
  end,
  ...over,
});

describe("domainOf", () => {
  it("returns null without spans", () => {
    expect(domainOf([])).toBeNull();
  });

  it("covers all spans", () => {
    expect(
      domainOf([
        { start: 10, end: 20 },
        { start: 5, end: 15 },
      ]),
    ).toEqual({ from: 5, to: 20 });
  });

  it("widens a single instant to one second", () => {
    expect(domainOf([{ start: 5000, end: 5000 }])).toEqual({ from: 5000, to: 6000 });
  });
});

describe("timeToX and xToTime", () => {
  const domain = { from: 1000, to: 2000 };

  it("maps time to pixels and back", () => {
    expect(timeToX(1000, domain, 200)).toBe(0);
    expect(timeToX(1500, domain, 200)).toBe(100);
    expect(timeToX(2000, domain, 200)).toBe(200);

    for (const time of [1000, 1234, 1500, 1999, 2000]) {
      const roundTrip = xToTime(timeToX(time, domain, 200), domain, 200);
      expect(roundTrip).toBeCloseTo(time, 6);
    }
  });

  it("treats a zero width as one pixel in xToTime", () => {
    // 0.5 of a 1px-wide track maps back to the domain midpoint.
    expect(xToTime(0.5, domain, 0)).toBeCloseTo(1500, 6);
  });
});

describe("packLane", () => {
  it("gives overlapping spans different sub-rows", () => {
    const { spans, rows } = packLane([span("b", 50, 150), span("a", 0, 100), span("c", 60, 200)]);

    expect(spans.map((item) => [item.key, item.subRow])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(rows).toBe(3);
  });

  it("lets touching spans share a sub-row", () => {
    const { spans, rows } = packLane([span("a", 0, 100), span("b", 100, 200)]);

    expect(spans.map((item) => item.subRow)).toEqual([0, 0]);
    expect(rows).toBe(1);
  });

  it("reuses a sub-row once it has ended, even mid-overlap", () => {
    // a [0,100] and b [50,150] overlap on row 0/1; c starts where a ended, reusing row 0.
    const { spans, rows } = packLane([span("a", 0, 100), span("b", 50, 150), span("c", 100, 120)]);

    expect(spans.map((item) => [item.key, item.subRow])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
    expect(rows).toBe(2);
  });
});

describe("zoomDomain", () => {
  const bounds = { from: 0, to: 10_000 };

  it("keeps the anchor at the same relative position", () => {
    const domain = { from: 0, to: 1000 };
    const anchor = 400;
    const zoomed = zoomDomain(domain, anchor, 0.5, bounds);

    expect(zoomed).toEqual({ from: 200, to: 700 });
    // The anchor maps to the same pixel position before and after.
    expect(timeToX(anchor, zoomed, 100)).toBeCloseTo(timeToX(anchor, domain, 100), 6);
  });

  it("respects a minimum width", () => {
    const zoomed = zoomDomain({ from: 0, to: 10_000 }, 5000, 0.001, bounds);
    expect(zoomed.to - zoomed.from).toBe(50);
  });

  it("clamps to the bounds", () => {
    const zoomed = zoomDomain({ from: 0, to: 1000 }, 100, 0.2, { from: 100, to: 10_000 });
    expect(zoomed).toEqual({ from: 100, to: 300 });
  });
});

describe("panDomain", () => {
  const bounds = { from: 0, to: 1000 };

  it("shifts the domain keeping its width", () => {
    expect(panDomain({ from: 100, to: 300 }, 100, bounds)).toEqual({ from: 200, to: 400 });
  });

  it("clamps at both bounds", () => {
    expect(panDomain({ from: 100, to: 300 }, -1000, bounds)).toEqual({ from: 0, to: 200 });
    expect(panDomain({ from: 100, to: 300 }, 5000, bounds)).toEqual({ from: 800, to: 1000 });
  });
});

describe("normalizeRange", () => {
  const bounds = { from: 0, to: 1000 };

  it("orders the endpoints and clamps to the bounds", () => {
    expect(normalizeRange(500, 100, bounds)).toEqual({ from: 100, to: 500 });
    expect(normalizeRange(-50, 2000, bounds)).toEqual({ from: 0, to: 1000 });
  });

  it("collapses to null", () => {
    expect(normalizeRange(100, 100, bounds)).toBeNull();
    // Both endpoints land outside the same bound after clamping.
    expect(normalizeRange(-30, -10, bounds)).toBeNull();
  });
});

describe("ticks", () => {
  it("returns round tick times inside the domain", () => {
    expect(ticks({ from: 1000, to: 6000 }, 5)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(ticks({ from: 1500, to: 5999 }, 5)).toEqual([2000, 3000, 4000, 5000]);
  });

  it("never exceeds the requested count by more than one tick", () => {
    for (const count of [1, 3, 6]) {
      const values = ticks({ from: 0, to: 10_000 }, count);
      expect(values.length).toBeLessThanOrEqual(count + 1);
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(10_000);
      }
    }
  });
});
