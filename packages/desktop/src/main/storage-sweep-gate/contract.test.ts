import { expect, it } from "vitest";

import { exampleLocalHostStartupGate } from "./contract.example.js";
import { desktopStorageSweepGateModule } from "./module.js";

it("declares its module manifest and keeps the first-claim invariant", async () => {
  expect(desktopStorageSweepGateModule.id).toBe("desktop-storage-sweep-gate");
  await expect(exampleLocalHostStartupGate()).resolves.toBeUndefined();
});
