// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { StorageCleanConfirmDialog } from "@/resource-manager/storage/StorageCleanConfirmDialog.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

afterEach(() => {
  cleanup();
  useConfirmDialogStore.getState().settleConfirmation(false);
});

describe("destructive confirmation keyboard guard", () => {
  it.each([undefined, "automation-confirmation"] as const)(
    "%s focuses cancel by default, Enter must not confirm, an explicit click confirms",
    async (presentation) => {
      render(createElement(ConfirmDialogHost));
      let result!: Promise<boolean>;
      act(() => {
        result = useConfirmDialogStore.getState().requestConfirmation({
          title: "Delete",
          description: "This deletion cannot be undone",
          presentation,
          confirmVariant: "destructive",
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
        });
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Cancel/ }));
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await expect(result).resolves.toBe(true);
    },
  );

  it.each(["plugin", "storage"] as const)(
    "%s standalone destructive dialogs also focus cancel by default",
    (kind) => {
      const confirm = vi.fn();
      render(
        kind === "plugin"
          ? createElement(PluginUninstallConfirmDialog, {
              open: true,
              pluginName: "test",
              pending: false,
              onCancel: vi.fn(),
              onConfirm: confirm,
            })
          : createElement(StorageCleanConfirmDialog, {
              target: { categoryId: "logs", bytes: 1024 },
              pending: false,
              onCancel: vi.fn(),
              onConfirm: confirm,
            }),
      );
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "common.cancel" }));
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("regular confirmations keep the Enter shortcut", async () => {
    render(createElement(ConfirmDialogHost));
    let result!: Promise<boolean>;
    act(() => {
      result = useConfirmDialogStore.getState().requestConfirmation({
        title: "Connect",
        description: "Connect the device",
      });
    });
    fireEvent.keyDown(window, { key: "Enter" });
    await expect(result).resolves.toBe(true);
  });
});
