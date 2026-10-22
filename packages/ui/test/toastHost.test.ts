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
});
