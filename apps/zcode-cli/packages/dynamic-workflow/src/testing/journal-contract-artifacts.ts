/**
 * Reason for the fix: journal-contract.ts hit the oxlint max-lines cap (400 lines), so the cases for user-facing artifact rows
 * (kind: "artifact", the artifactId column, report tags) were split into this file;
 * the public surface is still exported from journal-contract.ts (`runJournalStoreContract` calls each topic's registration function in the original order).
 *
 * Note: only `it(...)` cases are registered here, with no extra describe — the suite's grouping and case order must stay verbatim identical to before the split.
 */

import { expect, it } from "vitest";
import type { ArtifactVersionRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerArtifactCases(factory: () => JournalStorePort): void {
  // ——— User-facing artifacts (docs/dynamic-workflow/authoring.md) ———
  // ⚠ The artifact here is a deliverable a script publishes for the user to see, not `RunSettlement.artifact`
  // (the script's top-level return value). Both meanings coexist; see the spec's "Terminology" table.

  // The persisted shape of a successful content-member publish: `kind: "artifact"`, `result` being the entire ArtifactVersionRecord,
  // and `artifactId` pointing at the artifact it published. Both implementations must round-trip it **verbatim** — `uri` is the only
  // way out for the bytes (bytes do not go into the journal); transforming or dropping it turns a published artifact into an unopenable card.
  it("round-trips a completed artifact node with its version record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "book",
      kind: "file",
      version: 2,
      title: "注意力之书",
      description: "59 页 typst 排版",
      contentType: "application/pdf",
      bytes: 1_234_567,
      uri: "zcode-artifact://ses_parent/abc123",
      sourcePath: "out/book.pdf",
      publishedAt: 1_725_000_000_000,
      primary: true,
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 2,
      kind: "artifact",
      inputHash: "ah",
      status: "completed",
      result: record,
      artifactId: "book",
    };
    store.putNode(node);

    const stored = store.getNode("r1", "artifact#1", 2);
    expect(stored).toEqual(node);
    expect(stored?.result).toEqual(record);
  });

  // Preset-declaration row: the same kind, the same artifactId column, except result carries a spec instead of byte metadata.
  // The board itself holds no data (each of its points is a tagged report row), so this row is the entire record of "this board existed".
  it("round-trips a preset declaration artifact node with its spec", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "perf",
      kind: "chart",
      version: 1,
      title: "查询延迟",
      spec: { type: "line", x: { field: "round" }, y: [{ field: "queryMsAfter" }] },
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#2",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ph",
      status: "completed",
      result: record,
      artifactId: "perf",
    };
    store.putNode(node);
    expect(store.getNode("r1", "artifact#2", 1)).toEqual(node);
  });

  // A failed publish must be persisted **with its artifactId**: the read surface must be able to say "this publish for this id did not succeed".
  // A failed row has no result (the bytes were never written); the error lives on error — the same replay-sanity requirement
  // as settled failures having to be persisted.
  it("round-trips a failed artifact node with its error and artifact id", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failed: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 3,
      kind: "artifact",
      inputHash: "ah3",
      status: "failed",
      error: { code: "ArtifactSourceMissing", message: "out/book.pdf 不存在" },
      artifactId: "book",
    };
    store.putNode(failed);

    const stored = store.getNode("r1", "artifact#1", 3);
    expect(stored).toEqual(failed);
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // A content member goes through two writes, "admitted running → settled", while putNode is a whole-row-replacement upsert:
  // if the settle write no longer carries artifactId, the artifact's ownership gets wiped and that publish disappears from the
  // "which artifacts does this run have" read surface. The engine carries it in both writes; this case pins that shape at the storage layer.
  it("keeps the artifact id across the running → settled rewrite", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const running: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ah",
      status: "running",
      artifactId: "book",
    };
    store.putNode(running);
    expect(store.getNode("r1", "artifact#1", 1)).toEqual(running);

    store.putNode({
      ...running,
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
    });
    const settled = store.getNode("r1", "artifact#1", 1)!;
    expect(settled.status).toBe("completed");
    expect(settled.artifactId).toBe("book");
  });

  // Where the invariant "the board is a projection of the journal" lands: every point of a board is a row with
  // `kind = "report"` ∧ a matching `artifactId`. The tag must therefore live on the report row for as long as the item does.
  it("round-trips the artifact tag on a report node", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const tagged: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 3,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { round: 3, queryMsAfter: 12.5 },
      artifactId: "perf",
    };
    store.putNode(tagged);
    expect(store.getNode("r1", "report#1", 3)).toEqual(tagged);
  });

  // Untagged report, ask, and world-* rows, plus historical rows from before 0029, all lack this column: it must deserialize as an **absent key**,
  // not a key whose value is undefined. Board queries filter rows by "artifactId matches", and an extra key would fail
  // the whole toEqual and make "no tag" indistinguishable from "the tag is undefined" on the read surface.
  it("leaves artifactId absent on nodes that carry no artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const plain: NodeRecord = {
      runId: "r1",
      siteId: "report#2",
      ordinal: 1,
      kind: "report",
      inputHash: "rh2",
      status: "completed",
      result: { finding: "untagged" },
    };
    store.putNode(plain);

    const stored = store.getNode("r1", "report#2", 1)!;
    expect("artifactId" in stored).toBe(false);
    expect(stored).toEqual(plain);
  });

  // listNodes is the query surface the engine uses to recover artifact version numbers ("count of already-completed rows for that id + 1",
  // the same recovery method as reportCount), so the tag must also be present on the enumeration read surface — reading it back only on getNode is not enough.
  it("returns artifactId from listNodes as well as getNode", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putNode({
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "a1",
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
      artifactId: "book",
    });
    store.putNode({
      runId: "r1",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r1h",
      status: "completed",
      result: { round: 1 },
      artifactId: "perf",
    });
    store.putNode({
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "k1",
      status: "completed",
      result: "plain",
    });

    const nodes = store.listNodes("r1", { kinds: "all", withResult: true });
    expect(nodes.map((n) => n.artifactId)).toEqual(["book", "perf", undefined]);
    expect("artifactId" in nodes[2]!).toBe(false);
  });
}
