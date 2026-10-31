import { describe, expect, it } from "vitest";

import { dreamJournalModule } from "./module.js";

// This file is inside the managed module root but outside the vitest include (tests/**), so it does
// not run in the core suite. Behavior and contract-binding coverage lives in tests/memory-dream-journal.test.ts.
describe("dream-journal contract", () => {
  it("declares its module manifest", () => {
    expect(dreamJournalModule.id).toBe("dream-journal");
  });
});
