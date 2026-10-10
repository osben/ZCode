import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZCodeSourceHeadersFromContext,
  stripZcodeForkVersionSuffix,
} from "@zcode/shared";

test("stripZcodeForkVersionSuffix removes fork prerelease suffix", () => {
  assert.equal(stripZcodeForkVersionSuffix("3.15.1-fork.1"), "3.15.1");
  assert.equal(stripZcodeForkVersionSuffix("3.15.1-fork.12"), "3.15.1");
  assert.equal(stripZcodeForkVersionSuffix(" 3.15.1-fork.2 "), "3.15.1");
});

test("stripZcodeForkVersionSuffix keeps non-fork versions unchanged", () => {
  assert.equal(stripZcodeForkVersionSuffix("3.15.1"), "3.15.1");
  assert.equal(stripZcodeForkVersionSuffix("0.0.0-dev"), "0.0.0-dev");
  assert.equal(stripZcodeForkVersionSuffix("3.15.1-beta.2"), "3.15.1-beta.2");
  assert.equal(stripZcodeForkVersionSuffix("unknown"), "unknown");
  assert.equal(stripZcodeForkVersionSuffix("3.15.1.1"), "3.15.1.1");
});

test("source headers send upstream base version only", () => {
  const headers = buildZCodeSourceHeadersFromContext({
    appVersion: "3.15.1-fork.2",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(headers["User-Agent"], "ZCode/3.15.1");
  assert.equal(headers["X-ZCode-App-Version"], "3.15.1");
});

test("source headers keep plain and dev versions", () => {
  const plain = buildZCodeSourceHeadersFromContext({ appVersion: "3.15.1" });
  assert.equal(plain["User-Agent"], "ZCode/3.15.1");
  assert.equal(plain["X-ZCode-App-Version"], "3.15.1");

  const dev = buildZCodeSourceHeadersFromContext({ appVersion: "0.0.0-dev" });
  assert.equal(dev["User-Agent"], "ZCode/0.0.0-dev");
  assert.equal(dev["X-ZCode-App-Version"], "0.0.0-dev");

  const missing = buildZCodeSourceHeadersFromContext({});
  assert.equal(missing["User-Agent"], "ZCode/unknown");
  assert.equal("X-ZCode-App-Version" in missing, false);
});
