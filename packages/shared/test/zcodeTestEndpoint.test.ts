import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  resolveZCodeTestEndpointOrigin,
  selectZCodeEndpointMenuEntry,
} from "../src/zcodeEndpoint.js";

// Spec: specs/zcode-test-endpoint-menu.md
describe("resolveZCodeTestEndpointOrigin", () => {
  it("ZTE-01: without ZCODE_TEST_BASE_URL the scrubbed test constant equals production, so no test endpoint", () => {
    expect(resolveZCodeTestEndpointOrigin({ processEnv: {}, localEnv: {} })).toBeUndefined();
  });

  it("ZTE-02: ZCODE_TEST_BASE_URL becomes the normalized test origin, process env before local env", () => {
    expect(
      resolveZCodeTestEndpointOrigin({
        processEnv: { ZCODE_TEST_BASE_URL: " https://test.example.com/path " },
        localEnv: { ZCODE_TEST_BASE_URL: "https://local.example.com" },
      }),
    ).toBe("https://test.example.com");
    expect(
      resolveZCodeTestEndpointOrigin({
        processEnv: {},
        localEnv: { ZCODE_TEST_BASE_URL: "https://local.example.com" },
      }),
    ).toBe("https://local.example.com");
  });

  it("ZTE-03: a test origin equal to production is not a distinct test endpoint", () => {
    expect(
      resolveZCodeTestEndpointOrigin({
        processEnv: { ZCODE_TEST_BASE_URL: `${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/` },
        localEnv: {},
      }),
    ).toBeUndefined();
  });

  it("an invalid ZCODE_TEST_BASE_URL is ignored instead of breaking menu building", () => {
    expect(
      resolveZCodeTestEndpointOrigin({
        processEnv: { ZCODE_TEST_BASE_URL: "not a url" },
        localEnv: {},
      }),
    ).toBeUndefined();
  });

  it("an invalid process value falls back to a valid local .env value", () => {
    expect(
      resolveZCodeTestEndpointOrigin({
        processEnv: { ZCODE_TEST_BASE_URL: "not a url" },
        localEnv: { ZCODE_TEST_BASE_URL: "https://local.example.com" },
      }),
    ).toBe("https://local.example.com");
  });
});

describe("selectZCodeEndpointMenuEntry", () => {
  const testOrigin = "https://test.example.com";

  it("ZTE-02: the current origin equal to the available test origin selects Test", () => {
    expect(
      selectZCodeEndpointMenuEntry({ zcodeEnv: "test", currentOrigin: testOrigin, testOrigin }),
    ).toBe("test");
  });

  it("ZTE-01: the production origin selects Production, with or without a test origin", () => {
    for (const candidate of [testOrigin, undefined]) {
      expect(
        selectZCodeEndpointMenuEntry({
          zcodeEnv: "test",
          currentOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
          testOrigin: candidate,
        }),
      ).toBe("production");
    }
  });

  it("ZTE-04: any other origin selects Custom; production builds always select Production", () => {
    expect(
      selectZCodeEndpointMenuEntry({
        zcodeEnv: "test",
        currentOrigin: "http://localhost:3030",
        testOrigin,
      }),
    ).toBe("custom");
    expect(
      selectZCodeEndpointMenuEntry({
        zcodeEnv: "production",
        currentOrigin: testOrigin,
        testOrigin,
      }),
    ).toBe("production");
  });
});
