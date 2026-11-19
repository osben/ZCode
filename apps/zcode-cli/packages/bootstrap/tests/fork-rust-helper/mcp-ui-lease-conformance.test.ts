// Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 1): the Node half of the lease
// conformance. The same request sequence runs in Rust (protocol-zcode `fork/mcp_ui_lease_conformance_tests.rs`)
// against the lease registry; here it runs against `McpUiInstances`, and every step must give the same outcome.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpUiInstances } from "../../src/zcode-protocol/mcp-ui/instances.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/mcp_ui_lease_conformance.json",
    import.meta.url,
  ),
);

interface Connection {
  identity: string;
  generation: number;
}

interface Step {
  op: string;
  as?: string;
  lease?: string;
  session?: string;
  server?: string;
  scope?: string;
  source?: "current" | Connection;
  call?: string;
  onlyIfIdle?: boolean;
  expect: string;
}

interface Fixture {
  server: { name: string; identity: string; generation: number };
  steps: Step[];
}

const UNAUTHORIZED = "MCP App instance is no longer authorized";

function runSequence(fixture: Fixture): string[] {
  const instances = new McpUiInstances();
  const serverName = fixture.server.name;
  let current: Connection = {
    identity: fixture.server.identity,
    generation: fixture.server.generation,
  };
  // alias -> lease, in the order the fixture named them.
  const leases = new Map<string, ReturnType<McpUiInstances["open"]>>();
  const pins = new Map<string, { release(): void }>();
  const sessions = [...new Set(fixture.steps.map((step) => step.session).filter(Boolean))] as string[];

  const aliasOf = (lease: ReturnType<McpUiInstances["open"]>): string => {
    for (const [alias, known] of leases) if (known.token === lease.token) return alias;
    return "?";
  };
  const leaseOf = (step: Step) => {
    const lease = leases.get(step.lease ?? "");
    if (!lease) throw new Error(`unknown lease alias ${step.lease}`);
    return lease;
  };
  const sourceOf = (step: Step): Connection =>
    step.source === "current" || step.source === undefined ? current : step.source;
  const isLive = (lease: ReturnType<McpUiInstances["open"]>) => instances.find(lease.token) !== undefined;

  return fixture.steps.map((step) => {
    switch (step.op) {
      case "open": {
        const session = step.session ?? "";
        const lease = instances.open(
          {
            workspace: "/w",
            sessionId: session,
            pluginId: "p",
            serverName: step.server ?? serverName,
            scopeId: step.scope ?? "",
            resourceUri: "ui://a",
            ownerWebContentsId: 7,
          },
          sourceOf(step),
        );
        const reused = [...leases.values()].some((known) => known.token === lease.token);
        leases.set(step.as ?? "", lease);
        return reused ? "reused" : "opened";
      }
      case "validate": {
        const lease = leaseOf(step);
        try {
          instances.validate(
            lease,
            {
              sessionId: step.session ?? "",
              pluginId: "p",
              serverName: step.server ?? serverName,
              workspace: { workspacePath: "/w" },
            },
            sourceOf(step),
          );
          return "ok";
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
      }
      case "retain": {
        const lease = leaseOf(step);
        try {
          const pin = instances.retain(lease.token, step.call ?? "");
          pins.set(step.call ?? "", pin);
          return "pinned";
        } catch (error) {
          expect((error as Error).message).toBe(UNAUTHORIZED);
          return "unauthorized";
        }
      }
      case "release": {
        pins.get(step.call ?? "")?.release();
        return "ok";
      }
      case "busy":
        return instances.isBusy(leaseOf(step)) ? "busy" : "idle";
      case "close": {
        const lease = leaseOf(step);
        // Node closeMcpUiInstance: a busy panel under onlyIfIdle is kept open.
        if (step.onlyIfIdle && instances.isBusy(lease)) return "not-closed";
        return instances.close(lease) ? "closed" : "not-closed";
      }
      case "reconnect": {
        current = { ...current, generation: current.generation + 1 };
        // Node: onAppConnectionInvalidated closes the server's leases in each session.
        const revoked: string[] = [];
        for (const session of sessions) {
          for (const [alias, lease] of leases) {
            const record = instances.find(lease.token);
            if (record?.binding.sessionId === session && record.binding.serverName === serverName) {
              instances.close(lease);
              revoked.push(alias);
            }
          }
        }
        return `revoked:${revoked.join(",")}`;
      }
      case "closeSession": {
        const session = step.session ?? "";
        const live = [...leases].filter(([, lease]) => isLive(lease));
        instances.closeSession(session);
        const closed = live.filter(([, lease]) => !isLive(lease)).map(([alias]) => alias);
        return `closedSession:${closed.join(",")}`;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  });
}

describe("MCP App lease conformance (Node half)", () => {
  it("McpUiInstances matches every expected outcome of the shared fixture", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    const actual = runSequence(fixture);
    const expected = fixture.steps.map((step) => step.expect);
    const mismatches = expected
      .map((want, index) => ({ index, want, got: actual[index] }))
      .filter(({ want, got }) => want !== got);
    expect(mismatches).toEqual([]);
  });
});
