import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SG-01 static guard: the read-only timeline referenced directly by the public anonymous share page
// (packages/web/src/share) must be physically free of the open-with subtree (OpenSplitButton → platform
// hooks, tab store, workspace-file-tree, editorPreference, and other Desktop-only deps). This boundary
// used to rest only on source comments and the spec: re-adding a static value import would fail no test,
// silently growing the public page bundle with runtime deps that have no Desktop host. This test reads
// the source and asserts mechanically (following the readFileSync precedent of markdownTableStickyScrollbar.test.ts);
//
// denylist modules only allow `import type` (erased at build time).
// Blind-spot fix history: the first guard only matched imports at line start with a from clause, and
// denylist keys were `@/` alias literals, so side-effect imports `import "@/x"`, dynamic `import("@/x")`,
// and relative `from "../../x"` paths (common IDE autocomplete output) bypassed it silently. Specifier
const UI_SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

const SHARE_BOUNDARY_SOURCES = ["v4/ConversationShareReadonlyTimeline.tsx"] as const;

// Denylist: module roots that would drag the Desktop-only subtree into the public page bundle.
// @/OpenSplitButton.js is the open-with subtree entry; the other entries are its Desktop-only deps,
// guarding against static imports that bypass the entry. Specifiers are normalized to the @/ form
// first, so the denylist stores alias literals only. Append new boundary files or entries here.
const VALUE_IMPORT_DENYLIST: ReadonlySet<string> = new Set([
  "@/OpenSplitButton.js",
  "@/hooks/usePlatform.js",
  "@/hooks/useFileContextActions.js",
  "@/hooks/useWorkspaceOpenInEditorTarget.js",
  "@/lib/editorPreference.js",
  "@/lib/workspaceEditorSelection.js",
  "@/workspace-file-tree/model.js",
]);

type DeniedValueImportKind = "from-clause" | "side-effect" | "dynamic-import";

interface DeniedValueImport {
  specifier: string;
  kind: DeniedValueImportKind;
}

/**
 * Normalize an import specifier from the boundary file into the `@/` alias form.
 *
 * Fix rationale: when the denylist stored alias literals only, IDE autocomplete artifacts such as
 * `from "../../OpenSplitButton.js"` resolved to the same module yet failed the comparison — one
 * different spelling bypassed the guard. Relative paths are resolved against the ui package src root
 * and folded back to the alias form; anything landing outside src (should not happen) is left as-is for the literal-comparison fallback. Separators are normalized to `/` so comparisons work on Windows.
 */
function normalizeSpecifier(sourceDir: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const fromSrcRoot = relative(UI_SRC_ROOT, resolve(sourceDir, specifier)).replaceAll("\\", "/");
  return fromSrcRoot.startsWith("..") ? specifier : `@/${fromSrcRoot}`;
}

/**
 * Extract every value import in the boundary source that hits the denylist.
 *
 * Covers four forms:
 * 1. `import <clause> from "..."` — only `import type` is erased at build time; the rest count.
 * 2. `export <clause> from "..."` — re-exports drag values into the bundle too; judged as in 1.
 * 3. `import "..."` side-effect import — no type-erased variant exists; any hit counts.
 * 4. `import("...")` dynamic import — generates an async chunk for the public page; any hit counts.
 * The from-clause regex `[^"']*?` spans newlines, so multi-line imports match too; `^import` anchors
 * to line start to avoid matching trailing comments.
 */
function findDeniedValueImports(source: string, sourceDir: string): DeniedValueImport[] {
  const violations: DeniedValueImport[] = [];
  const fromClausePatterns: ReadonlyArray<readonly [RegExp, DeniedValueImportKind]> = [
    [/^import\s+([^"']*?)\s+from\s*["']([^"']+)["']/gm, "from-clause"],
    [/^export\s+([^"']*?)\s+from\s*["']([^"']+)["']/gm, "from-clause"],
  ];
  for (const [pattern, kind] of fromClausePatterns) {
    for (const match of source.matchAll(pattern)) {
      const clause = match[1] ?? "";
      const specifier = normalizeSpecifier(sourceDir, match[2] ?? "");
      // Only whole-statement `import type` / `export type` counts. The inline `import { type X }` form is
      // erased too, but boundary files uniformly use `import type`; pinning a single form keeps the
      // denylist review from loosening across two spellings.
      if (VALUE_IMPORT_DENYLIST.has(specifier) && !/^type\b/u.test(clause)) {
        violations.push({ specifier, kind });
      }
    }
  }
  const bareSpecifierPatterns: ReadonlyArray<readonly [RegExp, DeniedValueImportKind]> = [
    [/^import\s+["']([^"']+)["']/gm, "side-effect"],
    [/\bimport\s*\(\s*["']([^"']+)["']/g, "dynamic-import"],
  ];
  for (const [pattern, kind] of bareSpecifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = normalizeSpecifier(sourceDir, match[1] ?? "");
      if (VALUE_IMPORT_DENYLIST.has(specifier)) violations.push({ specifier, kind });
    }
  }
  return violations;
}

describe("conversation share public-page bundle boundary", () => {
  it("分享只读时间线对 open-with 子树只允许 import type 引用", () => {
    for (const sourceRelPath of SHARE_BOUNDARY_SOURCES) {
      const sourcePath = resolve(UI_SRC_ROOT, sourceRelPath);
      const violations = findDeniedValueImports(
        readFileSync(sourcePath, "utf8"),
        dirname(sourcePath),
      );
      expect(
        violations,
        `${sourceRelPath} 对 open-with 子树存在静态值 import（公开页 bundle 边界回归）：` +
          JSON.stringify(violations) +
          "。Desktop 侧能力请改由消费方经组件注入（见 artifactOpenAction 注入契约）。",
      ).toEqual([]);
    }
  });

  // Regression tests for the guard itself: the three forms missed by the first regex must all be caught,
  // so future extractor changes cannot reintroduce blind spots (a mechanical guard is only worth what its hardest-to-bypass form covers).
  describe("denylist 提取器形态覆盖（盲区自测）", () => {
    // Use a virtual directory deeper than the boundary file to mimic IDE autocomplete's multi-level relative
    // paths; relative resolution only does path math and never requires the directories to exist.
    const sourceDir = resolve(UI_SRC_ROOT, "v4/share/nested");

    it("多层相对路径 from 子句按别名根归一化后命中 denylist", () => {
      const violations = findDeniedValueImports(
        'import { OpenSplitButton } from "../../../OpenSplitButton.js";\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "from-clause" }]);
    });

    it("副作用导入（无 from 子句）命中 denylist", () => {
      const violations = findDeniedValueImports('import "@/OpenSplitButton.js";\n', sourceDir);
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "side-effect" }]);
    });

    it("动态 import() 命中 denylist（公开页会生成异步 chunk）", () => {
      const violations = findDeniedValueImports(
        'const mod = await import("@/OpenSplitButton.js");\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "dynamic-import" }]);
    });

    it("re-export 值形态命中 denylist", () => {
      const violations = findDeniedValueImports(
        'export { OpenSplitButton } from "@/OpenSplitButton.js";\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "from-clause" }]);
    });

    it("import type / export type / 非 denylist 模块不产生违规", () => {
      const violations = findDeniedValueImports(
        [
          'import type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";',
          'export type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";',
          'import { TooltipProvider } from "@/components/ui/tooltip.js";',
          'const x = await import("@zcode/shared");',
        ].join("\n"),
        sourceDir,
      );
      expect(violations).toEqual([]);
    });
  });
});
