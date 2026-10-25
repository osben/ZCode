import { describe, expect, it } from "vitest";
import {
  createOfficialMcpTrustedOriginRegistry,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import {
  buildAgentCaCertEnv,
  buildAgentEndpointOriginEnv,
  buildAgentNoProxyEnv,
  buildAgentProxyEnv,
  buildAgentRuntimeEnv,
  buildAgentWorkspaceIdentityEnv,
} from "../src/runtime-tools/agentProxyEnv.js";

describe("buildAgentProxyEnv", () => {
  it("returns an empty patch when no proxy is configured", () => {
    expect(buildAgentProxyEnv(undefined)).toEqual({});
    expect(buildAgentProxyEnv("")).toEqual({});
    expect(buildAgentProxyEnv("   ")).toEqual({});
  });

  it("sets the standard uppercase proxy keys plus ZCODE_HTTP_PROXY", () => {
    expect(buildAgentProxyEnv("http://127.0.0.1:7890")).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
    });
  });

  it("prepends http:// to a bare host:port", () => {
    expect(buildAgentProxyEnv("127.0.0.1:7890").HTTP_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("preserves an explicit scheme such as socks5", () => {
    expect(buildAgentProxyEnv("socks5://127.0.0.1:1080").ALL_PROXY).toBe("socks5://127.0.0.1:1080");
  });
});

describe("buildAgentCaCertEnv", () => {
  it("returns an empty patch without a cert path", () => {
    expect(buildAgentCaCertEnv(undefined)).toEqual({});
    expect(buildAgentCaCertEnv("  ")).toEqual({});
  });

  it("sets NODE_EXTRA_CA_CERTS and ZCODE_AGENT_CA_CERT to the cert path", () => {
    expect(buildAgentCaCertEnv("/tmp/zcode-network-ca.pem")).toEqual({
      NODE_EXTRA_CA_CERTS: "/tmp/zcode-network-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/zcode-network-ca.pem",
    });
  });
});

describe("buildAgentNoProxyEnv", () => {
  it("returns an empty patch without bypass rules", () => {
    expect(buildAgentNoProxyEnv(undefined)).toEqual({});
    expect(buildAgentNoProxyEnv("  ")).toEqual({});
  });

  it("sets standard no-proxy keys plus ZCODE_NO_PROXY", () => {
    expect(buildAgentNoProxyEnv(" localhost, 127.0.0.1 ,.example.com ")).toEqual({
      NO_PROXY: "localhost,127.0.0.1,.example.com",
      no_proxy: "localhost,127.0.0.1,.example.com",
      ZCODE_NO_PROXY: "localhost,127.0.0.1,.example.com",
    });
  });
});

describe("buildAgentRuntimeEnv", () => {
  it("merges proxy, no-proxy and the configured CA cert", () => {
    expect(
      buildAgentRuntimeEnv({
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
        caCertPath: "/tmp/root-ca.pem",
      }),
    ).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      ZCODE_NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
    });
  });

  it("injects no CA when the setting is empty, even if proxy is configured", () => {
    expect(buildAgentRuntimeEnv({ httpProxy: "http://127.0.0.1:7890" })).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
    });
  });

  it("injects the configured CA even without a proxy", () => {
    expect(
      buildAgentRuntimeEnv({ httpProxy: undefined, caCertPath: " /tmp/root-ca.pem " }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
    });
  });
});

/* CR-01: single-source invariant for official MCP trust decisions.
   Both sides share the same implementation from @zcode/shared, but the verdicts are only guaranteed to
   match when "the inputs match too". The host's input is env + settings overrides while the agent's
   input is env only — so the host-resolved authoritative origin must be passed down via ZCODE_BASE_URL,
   otherwise, with a test env + custom endpoint, the two sides are guaranteed to diverge. */
describe("buildAgentEndpointOriginEnv", () => {
  it("returns an empty patch when the origin is missing or blank", () => {
    expect(buildAgentEndpointOriginEnv(undefined)).toEqual({});
    expect(buildAgentEndpointOriginEnv("")).toEqual({});
    expect(buildAgentEndpointOriginEnv("   ")).toEqual({});
  });

  it("pins the resolved origin onto ZCODE_BASE_URL", () => {
    expect(buildAgentEndpointOriginEnv("https://zcode.z.ai")).toEqual({
      ZCODE_BASE_URL: "https://zcode.z.ai",
    });
  });

  it("outranks the inherited endpoint keys it must override", () => {
    // ZCODE_BASE_URL must outrank the inherited ZCODE_ENDPOINT_ORIGIN / ZCODE_TEST_BASE_URL,
    // otherwise the injection has no effect.
    const hostEnv = {
      ZCODE_ENDPOINT_ORIGIN: "https://inherited-endpoint.example",
      ZCODE_ENV: "test",
      ZCODE_TEST_BASE_URL: "https://inherited-test.example",
    };
    const agentEnv = {
      ...hostEnv,
      ...buildAgentEndpointOriginEnv("https://authoritative.example"),
    };

    expect(resolveRuntimeZCodeEndpointOrigin(agentEnv)).toBe("https://authoritative.example");
  });
});

describe("buildAgentWorkspaceIdentityEnv", () => {
  it("injects only a trimmed remote workspace identity", () => {
    expect(buildAgentWorkspaceIdentityEnv(" remote:ssh:host:/repo ")).toEqual({
      ZCODE_WORKSPACE_IDENTITY: "remote:ssh:host:/repo",
    });
    expect(buildAgentWorkspaceIdentityEnv("   ")).toEqual({});
    expect(buildAgentWorkspaceIdentityEnv(undefined)).toEqual({});
  });
});

describe("official MCP trust: host and agent must agree on the ZCode API origin", () => {
  // Settings-page custom endpoint: any origin different from the env base URL is valid; a neutral domain
  // is used so an open-source export rewriting the test-environment domain to the official one cannot
  // collide with the production base URL.
  const SETTINGS_ORIGIN = "https://custom-endpoint.example";
  const PLUGIN_ID = "official-tools@zcode-plugins-local";

  /** Host view: env + settings override (node.ts resolveCurrentZCodeEndpointOrigin). */
  function hostRegistry(env: Record<string, string>, overrideOrigin: string | undefined) {
    return createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => resolveRuntimeZCodeEndpointOrigin(env, { overrideOrigin }),
    });
  }

  /** Agent view: env only (zcode-protocol-entrypoint.ts). */
  function agentRegistry(env: Record<string, string>) {
    return createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => resolveRuntimeZCodeEndpointOrigin(env),
    });
  }

  async function verdict(
    registry: ReturnType<typeof createOfficialMcpTrustedOriginRegistry>,
    origin: string,
  ) {
    return (await registry.isTrusted({ mcpKey: "image_search", origin, pluginId: PLUGIN_ID }))
      .trusted;
  }

  it("agrees in test env once the resolved origin is injected", async () => {
    // Reproduction scenario: ZCODE_ENV=test (delivered explicitly by the desktop test package) + a settings-page custom endpoint ≠ env base URL.
    const hostEnv = { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://env-derived.example" };
    const agentEnv = {
      ...hostEnv,
      ...buildAgentEndpointOriginEnv(
        resolveRuntimeZCodeEndpointOrigin(hostEnv, { overrideOrigin: SETTINGS_ORIGIN }),
      ),
    };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agent = agentRegistry(agentEnv);

    for (const origin of [
      SETTINGS_ORIGIN,
      "https://env-derived.example",
      "https://attacker.example",
    ]) {
      expect(await verdict(agent, origin)).toBe(await verdict(host, origin));
    }
    // And both sides accept the settings-page origin — not a vacuous pass where "both consistently reject".
    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(true);
    expect(await verdict(agent, SETTINGS_ORIGIN)).toBe(true);
  });

  it("would diverge without the injection (guards against silently dropping it)", async () => {
    // Reverse guardrail: with the injection removed, this test must observe divergence; otherwise the
    // test above would be an always-true fake guardrail.
    const hostEnv = { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://env-derived.example" };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agentWithoutInjection = agentRegistry(hostEnv);

    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(true);
    expect(await verdict(agentWithoutInjection, SETTINGS_ORIGIN)).toBe(false);
  });

  it("agrees in production, where the settings override is ignored on both sides", async () => {
    // In production the override is ignored and the injected value equals the env-derived value; behavior must not change.
    const hostEnv = { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://zcode.z.ai" };
    const injected = resolveRuntimeZCodeEndpointOrigin(hostEnv, {
      overrideOrigin: SETTINGS_ORIGIN,
    });
    expect(injected).toBe("https://zcode.z.ai");

    const agentEnv = { ...hostEnv, ...buildAgentEndpointOriginEnv(injected) };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agent = agentRegistry(agentEnv);

    for (const origin of ["https://zcode.z.ai", SETTINGS_ORIGIN]) {
      expect(await verdict(agent, origin)).toBe(await verdict(host, origin));
    }
    expect(await verdict(host, "https://zcode.z.ai")).toBe(true);
    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(false);
  });
});
