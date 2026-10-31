// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
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

    await waitFor(() => {
      const host = document.querySelector("#zcode-toast-host");
      expect(host?.querySelector("svg.lucide-circle-check")).not.toBeNull();
      expect(host?.querySelector("svg.lucide-info")).not.toBeNull();
    });
    expect(document.querySelectorAll("#zcode-toast-host svg.lucide-circle-check")).toHaveLength(1);
  });
});
