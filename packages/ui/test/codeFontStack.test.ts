import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles.css", "utf8");
const codeViewerSource = readFileSync("packages/ui/src/components/ui/code-viewer.tsx", "utf8");
const diffViewerSource = readFileSync("packages/ui/src/components/ui/diff-viewer.tsx", "utf8");

describe("code font stack", () => {
  it("uses sans-serif CJK fallbacks before generic monospace", () => {
    expect(styles).toMatch(
      /--font-mono:[^;]*Consolas[^;]*"Microsoft YaHei UI"[^;]*"Microsoft YaHei"[^;]*"PingFang SC"[^;]*"Noto Sans CJK SC"[^;]*monospace;/u,
    );
  });

  it("leads with the bundled JetBrains Mono and defines the bundled UI sans stack", () => {
    expect(styles).toMatch(/--font-mono:\s*"JetBrains Mono Variable", "JetBrains Mono",/u);
    expect(styles).toMatch(
      /--font-sans:\s*"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,\s*\n?\s*sans-serif;/u,
    );
  });

  it("imports both bundled variable fonts", () => {
    expect(styles).toContain('@import "@fontsource-variable/inter/index.css"');
    expect(styles).toContain('@import "@fontsource-variable/jetbrains-mono/index.css"');
  });

  it("shares the CJK-safe mono token with code and diff viewers", () => {
    expect(codeViewerSource).toContain('"--diffs-font-family": "var(--font-mono)"');
    expect(diffViewerSource).toContain('"--diffs-font-family": "var(--font-mono)"');
  });
});
