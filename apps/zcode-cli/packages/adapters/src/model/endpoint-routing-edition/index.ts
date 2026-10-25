import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

// The platform gateway (the /api/v1/ultra-zai/... path under the runtime ZCode origin) returns
// 404 for GLM-5.3 (GLM-5.3-Flash works), while the agent/configs control plane currently
// returns no proxyEndpoint, so the official closed-source assembly connects to the provider
// directly. This fork therefore ships a direct edition: every request resolves routed:false
// and no endpoint is rewritten. The upstream static gateway stays in
// official-coding-plan-gateway.ts with its tests; point the edition back at
// createStaticProviderEndpointRoutingPort to restore gateway routing.
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
