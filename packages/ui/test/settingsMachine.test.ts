// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

afterEach(cleanup);

describe("settings machine annotation", () => {
  const remote: WorkspaceTabState = {
    id: "remote",
    kind: "workspace",
    label: "project",
    workspacePath: "/project",
    workspaceIdentity: "remote:server:source-a:/project",
    remoteSessionId: "session",
    remoteTarget: { kind: "docker", container: "dev-container" },
  };
  function wrap(child: React.ReactNode) {
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(
        SettingsMachinesProvider,
        {
          servers: [
            { sourceServerId: "source-a", displayName: "Build server", installState: "installed" },
          ],
        },
        createElement(TooltipProvider, {}, child),
      ),
    );
  }

  it("plugin user and project menus both write the device name; remote users do not use the monitor icon", () => {
    render(
      wrap(
        createElement(PluginScopeMenu, {
          selectedScopeKey: "user",
          userTarget: remote,
          workspaceTabs: [remote],
          onScopeKeyChange: vi.fn(),
        }),
      ),
    );
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toContain(
      expectedCopy("settings.machine.remote", { name: "Build server" }),
    );
    expect(trigger.querySelector(".lucide-monitor")).toBeNull();
    expect(trigger.querySelector(".lucide-cloud")).toBeTruthy();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(
      screen.getByRole("menuitemradio", {
        name: `project · ${expectedCopy("settings.machine.remote", { name: "Build server" })}`,
      }),
    ).toBeTruthy();
  });
});
