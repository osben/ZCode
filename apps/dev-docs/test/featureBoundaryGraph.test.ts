import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  getFeatureBoundaryGraphStats,
  getFeatureBoundaryNeighborhood,
  type FeatureBoundaryGraph,
} from "@/data/featureBoundaryGraph.js";
import { normalizeFeatureBoundaryGraph } from "@/data/featureBoundaryGraphSource.js";

const fixture: FeatureBoundaryGraph = {
  schemaVersion: 1,
  graphId: "fixture",
  purpose: "test",
  nodes: [
    {
      id: "capability.alpha",
      kind: "capability",
      label: "Alpha",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "service.beta",
      kind: "service",
      label: "Beta",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "state.gamma",
      kind: "state-owner",
      label: "Gamma",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
  ],
  edges: [
    {
      from: "capability.alpha",
      to: "service.beta",
      type: "served-by",
      rank: "must-inspect",
    },
    {
      from: "state.gamma",
      to: "capability.alpha",
      type: "projects-to",
      rank: "should-inspect",
    },
  ],
};

describe("feature boundary graph helpers", () => {
  it("keeps nodes, edges and per-kind statistics", () => {
    expect(getFeatureBoundaryGraphStats(fixture)).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      unresolvedEndpointCount: 0,
      kindCounts: {
        capability: 1,
        service: 1,
        "state-owner": 1,
      },
    });
  });

  it("returns first-order neighbors and adds undeclared endpoints", () => {
    const graph: FeatureBoundaryGraph = {
      ...fixture,
      edges: [
        ...fixture.edges,
        {
          from: "capability.alpha",
          to: "missing.delta",
          type: "depends-on",
          rank: "conditional",
        },
      ],
    };

    const neighborhood = getFeatureBoundaryNeighborhood(graph, "capability.alpha");
    expect(neighborhood.nodes.map((node) => node.id)).toEqual([
      "capability.alpha",
      "service.beta",
      "state.gamma",
      "missing.delta",
    ]);
    expect(neighborhood.edges).toHaveLength(3);
    expect(neighborhood.edges[2]).toMatchObject({
      source: "capability.alpha",
      target: "missing.delta",
    });
  });

  it("parses the current feature boundary YAML and keeps undeclared endpoints", async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
      ),
      "utf8",
    );
    const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
    const stats = getFeatureBoundaryGraphStats(graph);

    expect(stats).toMatchObject({
      // 416 declared nodes plus 2 unresolved endpoints; the YAML is hand-maintained, so update these when it grows.
      nodeCount: 418,
      edgeCount: 799,
      unresolvedEndpointCount: 2,
    });
    expect(graph.nodes.filter((node) => node.kind === "unresolved").map((node) => node.id)).toEqual(
      ["capability.mcp-oauth-authorization", "persistence.desktop-user-data-root"],
    );
  });
});
