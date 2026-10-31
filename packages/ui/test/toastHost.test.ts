// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { TID_TOAST } from "@zcode/shared/test-ids";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("toast host", () => {
  it("creates a single host when several toasts fire before the container mounts", async () => {
    vi.resetModules();
    const { toast } = await import("@/components/ui/toast.js");

    toast("first", { durationMs: 0 });
    toast("second", { durationMs: 0 });

    await waitFor(() => {
      const hostText = document.querySelector("#zcode-toast-host")?.textContent ?? "";
      expect(hostText).toContain("first");
      expect(hostText).toContain("second");
    });
    expect(document.querySelectorAll("#zcode-toast-host")).toHaveLength(1);
  });

  // Upstream 3.17.1 gave success notices their own icon; the merge had dropped the branch.
  it("renders a check icon for success notices and the info icon for info notices", async () => {
    vi.resetModules();
    const { toast } = await import("@/components/ui/toast.js");

    toast("saved", { variant: "success", durationMs: 0 });
    toast("heads up", { variant: "info", durationMs: 0 });

    const toastWith = (message: string) =>
      [...document.querySelectorAll(`#zcode-toast-host [data-testid="${TID_TOAST}"]`)].find(
        (element) => element.textContent?.includes(message),
      );
    await waitFor(() => {
      expect(toastWith("saved")).toBeDefined();
      expect(toastWith("heads up")).toBeDefined();
    });
    // Scope each icon to its own toast so a swapped variant mapping fails.
    const success = toastWith("saved");
    const info = toastWith("heads up");
    expect(success?.querySelector("svg.lucide-circle-check")).not.toBeNull();
    expect(success?.querySelector("svg.lucide-info")).toBeNull();
    expect(info?.querySelector("svg.lucide-info")).not.toBeNull();
    expect(info?.querySelector("svg.lucide-circle-check")).toBeNull();
  });
});
