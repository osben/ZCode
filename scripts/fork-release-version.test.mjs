import assert from "node:assert/strict";
import test from "node:test";
import { resolveForkBase } from "./fork-release-version.mjs";

test("resolveForkBase accepts upstream and existing fork versions", () => {
  assert.deepEqual(resolveForkBase("3.15.1"), {
    base: "3.15.1",
    isForkVersion: false,
  });
  assert.deepEqual(resolveForkBase("3.15.1-fork.12"), {
    base: "3.15.1",
    isForkVersion: true,
  });
});

test("resolveForkBase rejects prerelease and unsupported root versions", () => {
  assert.equal(resolveForkBase("3.15.1-rc.1"), null);
  assert.equal(resolveForkBase("3.15.1-beta.2"), null);
  assert.equal(resolveForkBase(" 3.15.1-fork.2 "), null);
  assert.equal(resolveForkBase("3.15.1.1"), null);
  assert.equal(resolveForkBase(null), null);
});
