import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  decodeAnalysisCore,
  encodeAnalysisCore,
  serializeCore,
  type AnalysisCore,
  type AnalysisCoreJson,
} from "../src/index.js";

// JSON round-trip of `AnalysisCore` (docs/chat/workflow-portfolio.md "Sample package format"): the portfolio freezes
// the core into core.json and every on-site projection is computed over the decoded result, so the decoded result must
// be byte-identical to the original core in canonical text, and the Maps' insertion order (the deterministic emission
// evaluation order) must not be scrambled by the round-trip. The whole corpus goes through this — the codec is
// written per type, so any shape a fixture exposes (multi-port joins, families, detached bodies, phase vocabulary)
// should pass just the same.
const graphsDir = join(dirname(fileURLToPath(import.meta.url)), "graphs");

/** Actually goes through the JSON text, not just object-level encode/decode. */
function roundTrip(core: AnalysisCore): AnalysisCore {
  return decodeAnalysisCore(JSON.parse(JSON.stringify(encodeAnalysisCore(core))) as AnalysisCoreJson);
}

function mapKeys(core: AnalysisCore): string[][] {
  return [
    [...core.facts.askData.keys()],
    [...core.facts.askActor.keys()],
    [...core.facts.worldReadData.keys()],
    [...core.facts.joinIn.keys()],
    [...core.facts.fanoutIn.keys()],
    [...core.types.siteType.keys()],
    [...core.types.joinPortTypes.keys()],
  ];
}

describe("AnalysisCore JSON codec", () => {
  const fixtures = readdirSync(graphsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  let withCore = 0;
  for (const fixture of fixtures) {
    it(`round-trips ${fixture}`, () => {
      const source = readFileSync(join(graphsDir, fixture), "utf8");
      const core = analyzeWorkflowScript(source).core;
      if (core === undefined) return;
      withCore += 1;
      const decoded = roundTrip(core);
      expect(serializeCore(decoded)).toBe(serializeCore(core));
      // Insertion order: serializeCore sorts fact groups by sink id, so on its own it cannot reveal a scrambled Map
      // order.
      expect(mapKeys(decoded)).toEqual(mapKeys(core));
      // Encoding is stable: encoding again yields the same JSON text (the exporter's core.json is diffable).
      expect(JSON.stringify(encodeAnalysisCore(decoded))).toBe(JSON.stringify(encodeAnalysisCore(core)));
    });
  }

  it("covered at least one fixture with a core", () => {
    expect(withCore).toBeGreaterThan(0);
  });
});

/** A hand-built core: the corpus has no join with holes in its port types, so construct one directly here. */
function tinyCore(): AnalysisCore {
  return {
    facts: {
      askActor: new Map([["ask#2", [{ exact: true, site: "actor#1" }]]]),
      // Deliberately non-lexicographic insertion, to check the round-trip does not sort.
      askData: new Map([
        ["ask#2", [{ exact: true, site: "ask#1" }]],
        ["ask#1", [{ exact: false, port: 1, site: "join#1" }]],
      ]),
      fanoutIn: new Map(),
      holeData: new Map(),
      joinIn: new Map([["join#1", [{ exact: true, port: 0, site: "ask#1" }]]]),
      returnData: [{ exact: true, site: "ask#2" }],
      worldReadData: new Map(),
    },
    sites: {
      actors: [{ id: "actor#1", loc: { column: 1, line: 1 }, name: "w", order: 0 }],
      asks: [
        { id: "ask#1", label: "a", loc: { column: 1, line: 2 }, order: 1 },
        { id: "ask#2", label: "b", loc: { column: 1, line: 3 }, order: 3 },
      ],
      fanouts: [],
      holes: [],
      joins: [{ id: "join#1", label: "join", loc: { column: 1, line: 4 }, order: 2 }],
      worldReads: [],
    },
    trace: {
      controls: [],
      events: [
        { at: "actor", actor: "actor#1", regions: [] },
        { at: "issue", phase: "unphased", regions: ["region#0", "call#1"], step: "ask#1" },
        { at: "settle", joins: ["call#1"], maybe: false, regions: ["region#0"], steps: ["ask#1"] },
        { at: "issue", phase: "unphased", regions: [], step: "ask#2" },
        // A join-only barrier: a second await of the same promise settles no step, but the
        // join is still where the strand's parked exits reconnect.
        { at: "settle", joins: ["call#2"], maybe: false, regions: ["region#0"], steps: [] },
        { at: "jump", kind: "return", phase: "unphased", regions: [], target: "region#0" },
      ],
      phases: [],
      regions: [
        { entered: true, id: "region#0", kind: "seq" },
        { entered: true, id: "call#1", kind: "call", label: "helper", parent: "region#0", strand: true },
        { entered: true, id: "call#2", kind: "call", parent: "region#0", strand: true },
      ],
      root: "region#0",
    },
    types: {
      joinPortTypes: new Map([["join#1", ["A", undefined, "B"]]]),
      siteType: new Map([
        ["ask#2", "B"],
        ["ask#1", "A"],
      ]),
    },
  };
}

describe("AnalysisCore JSON codec: edge cases", () => {
  it("encodes joinPortTypes holes as null and decodes them back to undefined", () => {
    const core = tinyCore();
    const encoded = encodeAnalysisCore(core);
    expect(encoded.types.joinPortTypes).toEqual([["join#1", ["A", null, "B"]]]);
    const text = JSON.stringify(encoded);
    expect(text).toContain('["A",null,"B"]');
    const decoded = decodeAnalysisCore(JSON.parse(text) as AnalysisCoreJson);
    const ports = decoded.types.joinPortTypes.get("join#1");
    expect(ports).toHaveLength(3);
    expect(ports?.[1]).toBeUndefined();
    expect(ports?.[1]).not.toBeNull();
    expect(serializeCore(decoded)).toBe(serializeCore(core));
    expect(serializeCore(decoded)).toContain('ports="A",-,"B"');
  });

  // The concurrency vocabulary (analyzer-strands-plan.md "Trace changes") is **additive** — two optional fields — so
  // core-json still stays at version 1: the round-trip must bring `OrderRegion.strand` and `SettleEvent.joins` back
  // verbatim, otherwise the core.json frozen into the portfolio would fold concurrency back into a single serial
  // timeline.
  it("round-trips the strand flag and a settle's joins", () => {
    const core = tinyCore();
    const decoded = roundTrip(core);
    expect(decoded.trace.regions[1]?.strand).toBe(true);
    const settle = decoded.trace.events[2];
    expect(settle?.at === "settle" ? settle.joins : undefined).toEqual(["call#1"]);
    const text = serializeCore(decoded);
    expect(text).toContain('region call#1 call parent=region#0 entered label="helper" strand');
    expect(text).toContain("settle ask#1 in=region#0 joins=call#1");
    expect(text).toBe(serializeCore(core));
  });

  // A barrier that only joins without settling: `steps` is an empty array and must still be an array after the
  // round-trip, not absent, otherwise the frozen core.json would leave the control-flow projection parking that strand
  // forever.
  it("round-trips a join-only settle and prints it without a step token", () => {
    const core = tinyCore();
    const decoded = roundTrip(core);
    const joinOnly = decoded.trace.events[4];
    expect(joinOnly?.at === "settle" ? joinOnly.steps : undefined).toEqual([]);
    expect(joinOnly?.at === "settle" ? joinOnly.joins : undefined).toEqual(["call#2"]);
    const text = serializeCore(decoded);
    expect(text).toContain("settle in=region#0 joins=call#2");
    expect(text).not.toContain("settle  in=region#0");
    expect(text).toBe(serializeCore(core));
  });

  it("preserves non-sorted Map insertion order", () => {
    const decoded = roundTrip(tinyCore());
    expect([...decoded.facts.askData.keys()]).toEqual(["ask#2", "ask#1"]);
    expect([...decoded.types.siteType.keys()]).toEqual(["ask#2", "ask#1"]);
  });

  // The two hole keys (`sites.holes` / `facts.holeData`) were added after 2026-09-28: sample packages frozen before
  // that lack both keys, and decoding must fill them in as "no holes" instead of letting the projections crash on
  // undefined.
  it("decodes a frozen core that predates holes (no holes / holeData keys)", () => {
    const encoded = encodeAnalysisCore(tinyCore());
    const { holeData: _holeData, ...facts } = encoded.facts;
    const { holes: _holes, ...sites } = encoded.sites;
    const legacy = { ...encoded, facts, sites } as unknown as AnalysisCoreJson;
    const decoded = decodeAnalysisCore(legacy);
    expect(decoded.sites.holes).toEqual([]);
    expect(decoded.facts.holeData).toEqual(new Map());
    expect(serializeCore(decoded)).toBe(serializeCore(tinyCore()));
  });

  it("stamps version 1 and rejects other versions", () => {
    const encoded = encodeAnalysisCore(tinyCore());
    expect(encoded.version).toBe(1);
    const foreign = { ...encoded, version: 2 } as unknown as AnalysisCoreJson;
    expect(() => decodeAnalysisCore(foreign)).toThrow(/version 2/);
  });
});
