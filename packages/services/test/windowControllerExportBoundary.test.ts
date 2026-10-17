import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

describe("window-controller package export boundary", () => {
  it("resolves the runtime in Node and rejects it before entering the browser graph", async () => {
    const options = {
      stdin: {
        contents:
          'import { createWindowHostControllerRuntime } from "@zcode/services/window-controller"; globalThis.runtime = createWindowHostControllerRuntime;',
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      },
      bundle: true,
      write: false,
      logLevel: "silent" as const,
    };
    await expect(build({ ...options, platform: "node" })).resolves.toMatchObject({ errors: [] });
    // esbuild reports a `"default": null` export target as a resolution failure, not "not exported".
    await expect(build({ ...options, platform: "browser" })).rejects.toThrow(
      /Could not resolve "@zcode\/services\/window-controller"/,
    );
  });
});
