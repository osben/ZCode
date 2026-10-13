import { describe, expect, it } from "vitest";
import { createProviderEndpointRoutingPort } from "../src/model/endpoint-routing-edition/index.js";

// The fork's default assembly is the direct edition: even the official Coding Plan endpoints
// must come back routed:false, otherwise GLM-5.3 gets a 404 from the platform gateway (see the
// fork section in provider-endpoint-routing.md).
describe("fork direct endpoint routing edition", () => {
  it.each([
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
    "https://OPEN.BIGMODEL.CN:443/api/anthropic/v1/messages/",
    "https://api.z.ai/api/anthropic/v1/messages?stream=true",
    "https://api.z.ai/api/paas/v4/chat/completions",
    "https://provider.example.test/api/anthropic/v1/messages",
    "not a URL",
  ])("keeps %s direct", async (url) => {
    const port = createProviderEndpointRoutingPort({
      endpointOrigin: "https://zcode.z.ai",
      httpClient: {} as never,
    });
    await expect(port.resolve(url)).resolves.toEqual({ routed: false, url });
  });
});
