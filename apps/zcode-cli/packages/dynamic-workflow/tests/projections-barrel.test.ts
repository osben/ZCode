import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `@zcode/dynamic-workflow/projections` is the pure projection barrel for the portfolio browser bundle
// (docs/chat/workflow-portfolio.md): the site recomputes projections live over a frozen core.json, so the whole chain
// must not drag `typescript` (the compiler only the analyzer uses when minting a core) into the front-end bundle.
// Rather than relying on the bundler to error out, this statically walks the ESM import closure of
// dist/projections.js (tsc has already erased type-only imports, so every remaining `from "…"` in dist is a runtime
// dependency) and asserts that no reachable file imports the bare specifier "typescript". Any change that hooks a
// projection module to a compiler-carrying module like causality-order.ts blows up here first, listing the leaking
// files.
//
// Depends on dist: turbo's test task dependsOn build; before running a bare `pnpm test` in the package directory run
// `pnpm run build` first, otherwise this checks the previous build's output.
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ENTRY = join(distDir, "projections.js");

/** The specifier of every static import / re-export (including `export … from`); side-effect imports count too. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) out.push((match[1] ?? match[2]) as string);
  return out;
}

/** The reachable dist files and the bare (non-relative) specifiers appearing in them, grouped by the file where each was found. */
function walk(entry: string): { files: string[]; bare: Map<string, string[]> } {
  const files: string[] = [];
  const bare = new Map<string, string[]>();
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        queue.push(resolve(dirname(file), spec));
      } else {
        const list = bare.get(spec) ?? [];
        list.push(file);
        bare.set(spec, list);
      }
    }
  }
  return { bare, files };
}

describe("projections barrel is browser-safe", () => {
  it("dist/projections.js exists (run `pnpm run build` first)", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it("no reachable dist file imports typescript (or any other bare specifier)", () => {
    const { bare, files } = walk(ENTRY);
    // The barrel itself plus the projection modules it re-exports — the closure must not degenerate to just the entry
    // file.
    expect(files.length).toBeGreaterThan(5);
    const leaks = [...bare.entries()].map(([spec, importers]) => `${spec} <- ${importers.join(", ")}`);
    expect(leaks, "bare imports reachable from the browser barrel").toEqual([]);
    expect(bare.has("typescript")).toBe(false);
    // Reverse check: running the same walk, the root export must reach typescript — otherwise the walk itself is
    // broken.
    expect(walk(join(distDir, "index.js")).bare.has("typescript")).toBe(true);
  });

  it("does not reach the analyzer front-end modules", () => {
    const { files } = walk(ENTRY);
    const names = files.map((file) => file.slice(distDir.length + 1));
    for (const forbidden of ["analysis/causality-order.js", "analysis/analyze.js", "compiler/compile.js", "analysis/domain.js"]) {
      expect(names, `${forbidden} must not be reachable`).not.toContain(forbidden);
    }
  });
});
