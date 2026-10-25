import { createLocalHostStartupGate } from "./contract.js";

/** Main gives the first local Host the sweep ticket; a later local Host waits until the first settles. */
export async function exampleLocalHostStartupGate(): Promise<void> {
  const gate = createLocalHostStartupGate();
  const first = gate.claim();
  const later = gate.claim();
  first.settle();
  await later.open;
}
