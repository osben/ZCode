import { describe, expect, it } from "vitest";
import { createProviderEndpointRoutingPort } from "../src/model/endpoint-routing-edition/index.js";

// fork 的默认装配是直连版本：官方 Coding Plan 端点也必须 routed:false 原样返回，
// 否则 GLM-5.3 会在平台网关上得到 404（见 provider-endpoint-routing.md 的 fork 章节）。
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
