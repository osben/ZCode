import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

// 平台网关（runtime ZCode origin 下的 /api/v1/ultra-zai/... 路径）对 GLM-5.3 返回 404
// （GLM-5.3-Flash 正常），而控制面 agent/configs 当前不返回 proxyEndpoint，官方闭源装配
// 因此直连 provider。fork 把开源装配替换为直连版本：一切请求 routed:false，不改写端点。
// 上游静态网关保留在 official-coding-plan-gateway.ts 及其测试中，恢复时指回即可。
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
