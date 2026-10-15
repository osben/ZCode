// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCustomizeDialog } from "@/WorkspaceCustomizeDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useWorkspaceDisplayStore } from "@/store/workspaceDisplayStore.js";

function currentEntry() {
  return useWorkspaceDisplayStore.getState().entries["/ws/a"];
}

function renderDialog() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkspaceCustomizeDialog, {
        open: true,
        onOpenChange: () => {},
        workspaceKey: "/ws/a",
        defaultName: "Folder A",
        entry: currentEntry(),
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  useWorkspaceDisplayStore.setState({ entries: {} });
});

describe("WorkspaceCustomizeDialog", () => {
  it("selects a color preset and persists it through Save", async () => {
    useWorkspaceDisplayStore.setState({ entries: {} });
    renderDialog();

    const blueButton = screen.getByLabelText("Blue");
    expect(blueButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(blueButton);
    await waitFor(() => expect(blueButton.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(useWorkspaceDisplayStore.getState().entries["/ws/a"]).toEqual({ color: "blue" });
    });
  });

  it("does not save the display name when Enter confirms an IME candidate", async () => {
    useWorkspaceDisplayStore.setState({ entries: {} });
    renderDialog();
    const input = screen.getByTestId("workspace-customize-display-name");

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });

    expect(useWorkspaceDisplayStore.getState().entries["/ws/a"]).toBeUndefined();
    expect(screen.getByTestId("workspace-customize-dialog")).toBeTruthy();
    fireEvent.compositionEnd(input);
  });

  it("re-seeds the saved selection when the dialog reopens", async () => {
    useWorkspaceDisplayStore.setState({
      entries: { "/ws/a": { color: "blue" } },
    });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText("Blue").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByLabelText("No color").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches between color presets without the selection reverting", async () => {
    useWorkspaceDisplayStore.setState({
      entries: { "/ws/a": { color: "red" } },
    });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText("Red").getAttribute("aria-pressed")).toBe("true"),
    );

    fireEvent.click(screen.getByLabelText("Blue"));
    await waitFor(() => {
      expect(screen.getByLabelText("Blue").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Red").getAttribute("aria-pressed")).toBe("false");
    });

    fireEvent.click(screen.getByLabelText("Green"));
    await waitFor(() => {
      expect(screen.getByLabelText("Green").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Blue").getAttribute("aria-pressed")).toBe("false");
    });

    fireEvent.click(screen.getByLabelText("No color"));
    await waitFor(() => {
      expect(screen.getByLabelText("No color").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Green").getAttribute("aria-pressed")).toBe("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(useWorkspaceDisplayStore.getState().entries["/ws/a"]).toBeUndefined();
    });
  });

  it("trims an explicitly customized display name before saving", async () => {
    useWorkspaceDisplayStore.setState({ entries: {} });
    renderDialog();
    const input = screen.getByTestId("workspace-customize-display-name");
    fireEvent.change(input, { target: { value: "  My Folder  " } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(useWorkspaceDisplayStore.getState().entries["/ws/a"]).toEqual({
        displayName: "My Folder",
      });
    });
  });

  it("prefills the display name input with the effective name", async () => {
    useWorkspaceDisplayStore.setState({ entries: {} });
    renderDialog();
    const input = screen.getByTestId("workspace-customize-display-name") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Folder A"));
  });
});
