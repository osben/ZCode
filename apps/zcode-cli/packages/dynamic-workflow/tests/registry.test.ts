import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import {
  facadeMemberOf,
  isSiteProducing,
  SITE_MEMBER_NAMES,
  siteProducingFunctionOfSymbol,
  WORLD_READ_REGISTRY,
  worldReadOp,
  worldReadOpOfSymbol,
} from "../src/facade/registry.js";

/**
 * world-read registry: the single source of truth for (facade container, member) → op (docs/execution-engine.md's
 * "The world-read registry"). The core property pinned here is **identity is decided by declaring container, not by bare name** —
 * `git.log` and top-level `log()` share a name, which is the only place adding `git.*` next could hurt.
 */

/** Compile a script and return a lookup that finds the symbol of nodes matching a given identifier/property name. */
function symbols(scriptText: string): (name: string) => ts.Symbol | undefined {
  const { program, scriptFile } = createWorkflowProgram(scriptText);
  const checker = program.getTypeChecker();
  const found = new Map<string, ts.Symbol>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !found.has(node.text)) found.set(node.text, symbol);
    }
    ts.forEachChild(node, walk);
  };
  walk(scriptFile);
  return (name) => found.get(name);
}

describe("world-read registry — pure lookup", () => {
  it("keys on (container, member), so a bare member name never resolves alone", () => {
    expect(worldReadOp("files", "glob")).toBe("glob");
    expect(worldReadOp("files", "read")).toBe("read");
    expect(worldReadOp("files", "grep")).toBe("grep");
    expect(worldReadOp("git", "changedFiles")).toBe("git-changed-files");
    expect(worldReadOp("git", "diff")).toBe("git-diff");
    expect(worldReadOp("git", "status")).toBe("git-status");
    expect(worldReadOp("git", "log")).toBe("git-log");
    // No container (top-level function) never matches: world-reads always hang off facade container objects.
    expect(worldReadOp(undefined, "glob")).toBeUndefined();
    // The same member name on a different container is simply not the same op — exactly the `git.log` vs top-level `log()` shape.
    expect(worldReadOp("git", "glob")).toBeUndefined();
    expect(worldReadOp("files", "log")).toBeUndefined();
    expect(worldReadOp("files", "nope")).toBeUndefined();
  });

  it("gives every op a distinct name and every member a distinct one too", () => {
    // op names are unique: they are the journal's inputHash and Boundary A's wire vocabulary.
    const ops = WORLD_READ_REGISTRY.map((row) => row.op);
    expect(new Set(ops).size).toBe(ops.length);
    // member names are unique across containers: facade-misuse's retyping gate looks candidates up by bare
    // name only to fill the name into diagnostic copy. A collision would not break the decision, but it would
    // make the name quoted in the copy ambiguous (see the facadeSiteMember comment in facade-misuse).
    // Breaking this property would mean threading the container into that layer too.
    const members = WORLD_READ_REGISTRY.map((row) => row.member);
    expect(new Set(members).size).toBe(members.length);
  });

  it("derives the site-producing member set from the table (plus ask)", () => {
    for (const row of WORLD_READ_REGISTRY) {
      expect(SITE_MEMBER_NAMES.has(row.member)).toBe(true);
      // Every row's op can be looked back up by (container, member) — the table is the single source of truth.
      expect(worldReadOp(row.container, row.member)).toBe(row.op);
    }
    expect(SITE_MEMBER_NAMES.has("ask")).toBe(true);
    // `"log"` **is** in this set, because `git.log` is in the table — while the top-level `log()` still produces no site.
    // This is precisely the proof that this bare-name list can only serve as a candidate key, never as an identity criterion.
    expect(SITE_MEMBER_NAMES.has("log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
  });

  it("treats report as a site-producing top-level function and log as not", () => {
    // report and log are both **top-level containerless** facade functions; the only dividing line is that report
    // has a journal keyed by site, so the facade-siting rule (direct calls only) must constrain it.
    expect(isSiteProducing(undefined, "report")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    expect(siteProducingFunctionOfSymbol(undefined)).toBeUndefined();
    // report is not a world-read and not a member of any container — it must not appear in those two tables.
    expect(worldReadOp(undefined, "report")).toBeUndefined();
    expect(SITE_MEMBER_NAMES.has("report")).toBe(false);
  });

  it("treats agent/Agent.ask as site-producing and log as not", () => {
    expect(isSiteProducing(undefined, "agent")).toBe(true);
    expect(isSiteProducing("Agent", "ask")).toBe(true);
    expect(isSiteProducing("files", "glob")).toBe(true);
    expect(isSiteProducing("files", "grep")).toBe(true);
    expect(isSiteProducing("git", "log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    // Key defense: a `log` **without a container** produces no site. `git.log` has already landed, so this line is
    // actively preventing "every progress message minting a world-read site".
    expect(worldReadOp(undefined, "log")).toBeUndefined();
  });
});

describe("world-read registry — declaration-based resolution", () => {
  const lookup = symbols(
    `const paths = await files.glob("src/**");\n` +
      `const body = await files.read(paths[0] ?? "x");\n` +
      `log(body);\n` +
      `const out = await agent("a").ask<string>("go");\n` +
      `return out;\n`,
  );

  it("resolves a facade member's declaring container from its declaration", () => {
    expect(facadeMemberOf(lookup("glob"))).toEqual({ container: "files", member: "glob" });
    expect(facadeMemberOf(lookup("read"))).toEqual({ container: "files", member: "read" });
    // `ask` is declared in `declare interface Agent` → its container is Agent (an interface container).
    expect(facadeMemberOf(lookup("ask"))).toEqual({ container: "Agent", member: "ask" });
    // Top-level facade functions have no container — that is why `git.log` cannot collide with them.
    expect(facadeMemberOf(lookup("log"))).toEqual({ container: undefined, member: "log" });
    expect(facadeMemberOf(lookup("agent"))).toEqual({ container: undefined, member: "agent" });
  });

  it("resolves the two bare site-producing functions and rejects log", () => {
    const fns = symbols(
      `report({ a: 1 });\nlog("x");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
    );
    expect(siteProducingFunctionOfSymbol(fns("report"))).toBe("report");
    expect(siteProducingFunctionOfSymbol(fns("agent"))).toBe("agent");
    expect(siteProducingFunctionOfSymbol(fns("log"))).toBeUndefined();
    // Container members take the other path (worldReadOp / ASK_MEMBER) and must not match through this entry.
    expect(siteProducingFunctionOfSymbol(fns("ask"))).toBeUndefined();
  });

  it("does not resolve a script-local function named report", () => {
    const local = symbols(
      `const report = (item: unknown): void => { void item; };\nreport({ a: 1 });\nreturn 1;\n`,
    );
    expect(siteProducingFunctionOfSymbol(local("report"))).toBeUndefined();
    expect(facadeMemberOf(local("report"))).toBeUndefined();
  });

  it("maps only facade-declared members to ops", () => {
    expect(worldReadOpOfSymbol(lookup("glob"))).toBe("glob");
    expect(worldReadOpOfSymbol(lookup("read"))).toBe("read");
    expect(worldReadOpOfSymbol(lookup("log"))).toBeUndefined();
    expect(worldReadOpOfSymbol(lookup("ask"))).toBeUndefined();
    expect(worldReadOpOfSymbol(undefined)).toBeUndefined();
  });

  it("resolves the two `log` declarations to different identities in one script", () => {
    // Two `log`s in the same script: `git.log`'s container is git (→ "git-log" op), the top-level `log` has no container
    // (→ not a world-read). symbols()' lookup takes the **first** symbol seen per name, so the two sides must be
    // fetched separately: first with only the top-level log, then with only git.log.
    const topLevel = symbols(`log("progress");\nreturn 1;\n`);
    expect(facadeMemberOf(topLevel("log"))).toEqual({ container: undefined, member: "log" });
    expect(worldReadOpOfSymbol(topLevel("log"))).toBeUndefined();

    const gitLog = symbols(`const c = await git.log(3);\nreturn c.length;\n`);
    expect(facadeMemberOf(gitLog("log"))).toEqual({ container: "git", member: "log" });
    expect(worldReadOpOfSymbol(gitLog("log"))).toBe("git-log");
  });

  it("resolves the whole git container and files.grep from declarations", () => {
    const git = symbols(
      `const changed = await git.changedFiles();\n` +
        `const d = await git.diff("HEAD");\n` +
        `const s = await git.status();\n` +
        `const hits = await files.grep("TODO", "*.ts");\n` +
        `return [changed.length, d.length, s.clean, hits.length];\n`,
    );
    expect(worldReadOpOfSymbol(git("changedFiles"))).toBe("git-changed-files");
    expect(worldReadOpOfSymbol(git("diff"))).toBe("git-diff");
    expect(worldReadOpOfSymbol(git("status"))).toBe("git-status");
    expect(worldReadOpOfSymbol(git("grep"))).toBe("grep");
    expect(facadeMemberOf(git("grep"))).toEqual({ container: "files", member: "grep" });
  });

  it("does not resolve a script-local object whose members merely share the names", () => {
    const local = symbols(
      `const fake = { glob(p: string): string[] { return [p]; }, read(p: string): string { return p; } };\n` +
        `const out = fake.glob("x").join(fake.read("y"));\n` +
        `return out;\n`,
    );
    expect(facadeMemberOf(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("read"))).toBeUndefined();
  });

  it("does not resolve a script-local `git`-shaped object (shadowing the facade)", () => {
    // A hand-built `myGit.status()`: name and container shape both line up, but the declaration is not in the facade .d.ts.
    const local = symbols(
      `const myGit = { status(): string { return "clean"; }, log(n: number): number { return n; } };\n` +
        `return myGit.status() + String(myGit.log(1));\n`,
    );
    expect(worldReadOpOfSymbol(local("status"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("log"))).toBeUndefined();
  });
});

describe("world-read registry — site collection uses it", () => {
  it("sites facade world reads with the registry op, not the member name", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const paths = await files.glob("src/**");\n` +
          `const body = await files.read(paths[0] ?? "x");\n` +
          `return body;\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual(["glob", "read"]);
    expect(table.worldReads.map((site) => site.id)).toEqual(["world-read#1", "world-read#2"]);
    // Args are collected positionally (the seam for multi-arg ops; a 1-arg op is a single-element array).
    expect(table.worldReads[0]?.args).toHaveLength(1);
  });

  it("sites every new op on one shared world-read counter, args packed positionally", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const hits = await files.grep("TODO", "*.ts");\n` +
          `const changed = await git.changedFiles();\n` +
          `const d = await git.diff("main", "src/a.ts");\n` +
          `const s = await git.status();\n` +
          `const c = await git.log(5);\n` +
          `return [hits.length, changed.length, d.length, s.clean, c.length];\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual([
      "grep",
      "git-changed-files",
      "git-diff",
      "git-status",
      "git-log",
    ]);
    // A **shared** per-kind counter (`world-read#N` with an op field), not `grep#N`/`git-log#N`.
    expect(table.worldReads.map((site) => site.id)).toEqual([
      "world-read#1",
      "world-read#2",
      "world-read#3",
      "world-read#4",
      "world-read#5",
    ]);
    // Arity is collected positionally as-is: an absent optional argument is just a shorter array (which keeps journal keys distinguishable).
    expect(table.worldReads.map((site) => site.args.length)).toEqual([2, 0, 2, 0, 1]);
  });

  it("mints no world-read site for a same-named script-local method", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const fake = { glob(p: string): string[] { return [p]; } };\n` +
          `const out = fake.glob("x");\n` +
          `return out.length;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
  });

  it("mints a site for git.log and none for the top-level log, in one script", () => {
    // This is the executable proof of the registry being keyed by container. Either fate of the bare-name set
    // would show up here: either `log("progress")` also gets minted as a world-read site (2 sites), or `git.log`
    // gets no site at all (0 sites) — and a facade call without a site has no journal key.
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\n` +
          `const c = await git.log(3);\n` +
          `log("done");\n` +
          `const out = await agent("a").ask<string>(String(c.length));\n` +
          `return out;\n`,
      ),
    );
    expect(table.worldReads).toHaveLength(1);
    expect(table.worldReads[0]?.op).toBe("git-log");
    expect(table.worldReads[0]?.id).toBe("world-read#1");
    expect(table.asks).toHaveLength(1);
  });

  it("mints no world-read site for the top-level log alone", () => {
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
    expect(table.asks).toHaveLength(1);
  });
});
