import type { IServiceAccessor } from "@/hooks/useServices.js";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { expectedCopy } from "./helpers/uiCopy.js";

// The component's top-level hook chain (useWorkspaceServicesResolution -> useServices) requires a context;
// the no-workspace branch never actually calls any service method, so an empty accessor suffices.
const emptyAccessor = {} as unknown as IServiceAccessor;

function renderSection(props: { workspacePath?: string | null }): string {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: emptyAccessor },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkspaceFileSearchSection, props),
      ),
    ),
  );
}

describe("WorkspaceFileSearch settings section", () => {
  it("renders a hint instead of the editor when no workspace is open", () => {
    // The no-workspace branch never touches services: render the hint directly instead of pulling the file service.
    const html = renderSection({ workspacePath: null });
    // Pin the locale explicitly so the same component does not fail assertions on CI due to system language.
    expect(html).toContain(expectedCopy("settings.workspaceFileSearch.noWorkspace"));
    expect(html).not.toContain("workspace-file-search-ignore-editor");
  });

  it("wires the ignore editor to the fileService RPC contract", () => {
    // Contract assertions (same pattern as hooksSection): the editor page must go through fileService's
    // dedicated RPC and may not bypass the service layer to read/write local files directly; section
    // operations must go through applyTransform (section rewrite, never a wholesale overwrite of user content).
    const source = readFileSync(
      new URL("../src/settings/WorkspaceFileSearchSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("readWorkspaceFileSearchIgnore");
    expect(source).toContain("writeWorkspaceFileSearchIgnore");
    expect(source).toContain("applyWorkspaceFileSearchIgnoreTransform({");
    expect(source).toContain("transform,");
    expect(source).not.toContain("readTextFile");
    expect(source).not.toContain("window.zcode");
  });
});
