import { defineConfig } from "tsup";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: { entry: "src/adapters/entry.ts", deviceStoreWorker: "src/adapters/deviceStoreWorker.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  tsconfig: "tsconfig.json",
  noExternal: ["@zcode/shared", "zod"],
  external: ["ws", "node:sqlite"],
  onSuccess: async () => {
    const notices = resolve(import.meta.dirname, "dist/notices");
    await mkdir(notices, { recursive: true });
    await cp(resolve(import.meta.dirname, "../../LICENSE"), resolve(notices, "ZCode-LICENSE"));
    await cp(resolve(dirname(require.resolve("ws/package.json")), "LICENSE"), resolve(notices, "ws-LICENSE"));
    await cp(resolve(dirname(require.resolve("zod/package.json")), "LICENSE"), resolve(notices, "zod-LICENSE"));
  },
});
