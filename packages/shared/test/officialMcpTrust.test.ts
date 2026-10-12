/* Official MCP trust decision (spec §5.1 / §5.2).
 *
 * Rule: the target origin equals the current ZCode API origin (https).
 *
 * 2026-08 decision change: the "pluginId must end with `@zcode-plugins-official`" check was removed.
 * It prevented official plugins from self-testing against the real endpoint before publishing to the official
 * marketplace (locally installed plugin ids are `@inline` or `@<local marketplace>`), and the dev loopback
 * switch only opens http loopback, which cannot help https endpoints. The only load-bearing check left is
 * **origin equality** (anti-exfiltration).
 */
import { describe, expect, it } from "vitest";
import {
  createOfficialMcpTrustedOriginRegistry,
  isOfficialMcpOriginTrusted,
} from "../src/official-mcp-auth.js";

const OFFICIAL_PLUGIN = "zcode-tools@zcode-plugins-official";
const ZCODE_ORIGIN = "https://zcode.z.ai";

function check(input: {
  devTrustedOriginsRaw?: string;
  origin: string;
  pluginId?: string;
  zcodeApiOrigin?: string | undefined;
}) {
  return isOfficialMcpOriginTrusted({
    devTrustedOriginsRaw: input.devTrustedOriginsRaw,
    origin: input.origin,
    pluginId: input.pluginId ?? OFFICIAL_PLUGIN,
    zcodeApiOrigin: "zcodeApiOrigin" in input ? input.zcodeApiOrigin : ZCODE_ORIGIN,
  });
}

describe("isOfficialMcpOriginTrusted", () => {
  it("trusts the current ZCode API origin", () => {
    expect(check({ origin: ZCODE_ORIGIN })).toEqual({ detail: "ok", trusted: true });
    // A URL with a path normalizes to the same origin (real endpoint shape: POST /api/v1/mcp/server/:mcp_group)
    expect(check({ origin: `${ZCODE_ORIGIN}/api/v1/mcp/server/image_search` })).toMatchObject({
      trusted: true,
    });
  });

  it("accepts any plugin id at the correct origin", () => {
    // pluginId no longer participates in the decision: inline, local marketplace, and third-party are all judged by origin alone.
    for (const pluginId of [
      "official-tools@zcode-plugins-local",
      "dev-official-mcp@inline",
      "evil@third-party",
      "zcode-tools",
    ]) {
      expect(check({ origin: ZCODE_ORIGIN, pluginId })).toEqual({ detail: "ok", trusted: true });
    }
  });

  it("still rejects those same plugins at a wrong origin", () => {
    // With the marketplace check removed, origin is the only barrier — confirm it was not loosened along with it.
    for (const pluginId of ["evil@third-party", "official-tools@zcode-plugins-local"]) {
      expect(check({ origin: "https://attacker.example", pluginId })).toEqual({
        detail: "origin_mismatch",
        trusted: false,
      });
    }
  });

  it("rejects any origin other than the resolved ZCode API origin", () => {
    for (const origin of [
      "https://attacker.example",
      "https://zcode.z.ai.attacker.example",
      "https://evil-zcode.z.ai",
      `${ZCODE_ORIGIN}:8443`,
    ]) {
      expect(check({ origin })).toEqual({ detail: "origin_mismatch", trusted: false });
    }
  });

  it("rejects http even when the host matches", () => {
    // Origin equality is load-bearing, but https is still mandatory — plaintext exposes credentials on the wire
    expect(check({ origin: "http://zcode.z.ai" })).toMatchObject({ trusted: false });
  });

  it("rejects credential-bearing URLs on either side", () => {
    expect(check({ origin: `https://user:pass@zcode.z.ai` })).toMatchObject({ trusted: false });
    expect(
      check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: "https://user:pass@zcode.z.ai" }),
    ).toMatchObject({ trusted: false });
  });

  it("fails closed when the ZCode API origin cannot be resolved", () => {
    expect(check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: undefined })).toEqual({
      detail: "zcode_origin_unresolved",
      trusted: false,
    });
    expect(check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: "not-a-url" })).toEqual({
      detail: "zcode_origin_unresolved",
      trusted: false,
    });
  });

  it("rejects malformed input without throwing", () => {
    expect(check({ origin: "" })).toEqual({ detail: "invalid_input", trusted: false });
    expect(check({ origin: "not-a-url" })).toMatchObject({ trusted: false });
    // An empty pluginId is no longer a rejection reason, but an empty origin is
    expect(check({ origin: ZCODE_ORIGIN, pluginId: "" })).toMatchObject({ trusted: true });
  });

  describe("dev loopback switch", () => {
    it("accepts a loopback origin listed in the switch", () => {
      expect(
        check({ devTrustedOriginsRaw: "http://127.0.0.1:3999", origin: "http://127.0.0.1:3999" }),
      ).toEqual({ detail: "ok", trusted: true });
    });

    it("only opens loopback, never a remote origin", () => {
      // Critical: the dev switch must never become a channel for "one env var steering JWTs to any site"
      for (const entry of ["https://attacker.example", "http://evil.example"]) {
        expect(check({ devTrustedOriginsRaw: entry, origin: entry })).toMatchObject({
          trusted: false,
        });
      }
    });

    it("supports several comma-separated entries and ignores blanks", () => {
      const raw = " http://127.0.0.1:3999 , ,http://localhost:4010 ";
      expect(check({ devTrustedOriginsRaw: raw, origin: "http://localhost:4010" })).toMatchObject({
        trusted: true,
      });
      expect(check({ devTrustedOriginsRaw: raw, origin: "http://127.0.0.1:5000" })).toMatchObject({
        trusted: false,
      });
    });

    it("does not require an official plugin for loopback self-testing", () => {
      // A local plugin loaded via dirs has marketplace "inline"; self-testing must keep working
      expect(
        check({
          devTrustedOriginsRaw: "http://127.0.0.1:3999",
          origin: "http://127.0.0.1:3999",
          pluginId: "dev-official-mcp@inline",
        }),
      ).toMatchObject({ trusted: true });
    });

    it("changes nothing when the switch is absent", () => {
      expect(check({ origin: "http://127.0.0.1:3999" })).toMatchObject({ trusted: false });
    });

    it("still rejects a loopback origin that is not listed", () => {
      // With the marketplace check removed, loopback origins must also be allowlisted entry by entry; http loopback alone must not pass
      expect(
        check({ devTrustedOriginsRaw: "http://127.0.0.1:3999", origin: "http://127.0.0.1:9999" }),
      ).toMatchObject({ trusted: false });
    });
  });
});

describe("createOfficialMcpTrustedOriginRegistry", () => {
  it("resolves the ZCode API origin per call, so environment switches are picked up", async () => {
    let origin = ZCODE_ORIGIN;
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => origin,
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });

    // After switching to the test environment domain, the old origin immediately stops being trusted
    origin = "https://zcode-test.z.ai";
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: false });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: "https://zcode-test.z.ai",
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });
  });

  it("fails closed when the origin resolver throws", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => {
        throw new Error("settings unavailable");
      },
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toEqual({ detail: "zcode_origin_unresolved", trusted: false });
  });

  it("awaits an async origin resolver", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: async () => ZCODE_ORIGIN,
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });
  });

  it("ignores mcpKey entirely (no per-key allowlist any more)", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
    });
    for (const mcpKey of ["image-search", "brand-new-mcp", ""]) {
      await expect(
        registry.isTrusted({ mcpKey, origin: ZCODE_ORIGIN, pluginId: OFFICIAL_PLUGIN }),
      ).resolves.toMatchObject({ trusted: true });
    }
  });
});
