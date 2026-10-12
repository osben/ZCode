import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

describe("ControlHintTooltip", () => {
  it("uses sm typography for tooltip copy and xs typography for shortcuts", () => {
    const tooltipSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/components/ui/tooltip.tsx"),
      "utf8",
    );
    const controlHintSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/ControlHintTooltip.tsx"),
      "utf8",
    );

    expect(tooltipSource).toContain("text-ui-sm text-tooltip-foreground");
    expect(tooltipSource).not.toContain("text-ui-base text-tooltip-foreground");
    expect(controlHintSource).not.toContain("text-ui-base");
    expect(controlHintSource).toContain("text-ui-xs font-medium text-tooltip-tag-foreground");
  });

  it("only creates a Radix tooltip provider for standalone tooltip instances", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/ControlHintTooltip.tsx"),
      "utf8",
    );

    // The shared Provider lives in Root (see Root.tsx). Only the `standalone` escape hatch may create its own,
    // so what is asserted is "the Provider must be gated behind standalone", not "no Provider in the source" —
    // the latter would also ban the intentional standalone capability.
    expect(source).toContain("standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip");
    expect(source.match(/<TooltipProvider>/g)).toHaveLength(1);
    expect(source.match(/<\/TooltipProvider>/g)).toHaveLength(1);

    // Load-bearing: the default must be false. If the default ever flips, every message action in a large session
    // builds its own Provider, blowing the Radix context tree up to message scale — exactly the regression this test blocks.
    expect(source).toContain("standalone = false");
  });

  it("keeps the composed trigger ref stable across Radix asChild renders", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/ControlHintTooltip.tsx"),
      "utf8",
    );

    expect(source).not.toContain("ref: composeRefs(");
    expect(source).toContain("const composedTriggerRef = useCallback(");
    expect(source).toContain("[childRef, triggerRef]");
  });

  it("keeps long localized titles visible within the viewport", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/ControlHintTooltip.tsx"),
      "utf8",
    );

    expect(source).toContain("max-w-[min(28rem,calc(100vw-1rem))]");
    expect(source).toContain("whitespace-pre-line break-words");
    expect(source).not.toContain("font-medium whitespace-nowrap text-tooltip-foreground");
  });

  it("renders an icon button trigger without falling back to a nested Radix button", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          ControlHintTooltip,
          { title: "Send", shortcut: "Enter" },
          createElement(
            Button,
            { type: "submit", size: "icon-lg", "aria-label": "Send" },
            createElement("span", { "aria-hidden": true }, "↑"),
            createElement("span", { className: "sr-only" }, "Send"),
          ),
        ),
      ),
    );

    expect(html).toMatch(/^<button[^>]*data-slot="tooltip-trigger"/);
    expect(html).not.toContain('<span data-slot="tooltip-trigger"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('type="submit"');
  });
});
