// Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 3): the Node half of the app-tools
// conformance. The same request sequence runs in Rust (protocol-zcode `fork/mcp_ui_app_tools_conformance_tests.rs`)
// against the owner's mailbox; here it runs against `McpUiAppToolRegistry` with `McpUiInstances` for the leases, and
// every step must give the same outcome. The lease checks the protocol makes (`validate`, then the binding) are made
// here the same way, and the registry's close notice (the abort listener) is the runner's `closePanel`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpAppProvidedToolDefinition } from "@zcode/core";
import { McpUiAppToolRegistry, McpUiInstances } from "../../src/zcode-protocol/mcp-ui/contract.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/mcp_ui_app_tools_conformance.json",
    import.meta.url,
  ),
);

interface Step {
  op: string;
  as?: string;
  lease?: string;
  session?: string;
  server?: string;
  scope?: string;
  tools?: string[];
  tool?: string;
  arguments?: Record<string, unknown>;
  call?: string;
  result?: Record<string, unknown>;
  expect: string;
}

interface Fixture {
  server: { name: string; identity: string; generation: number };
  steps: Step[];
}

interface Lease {
  runtimeId: string;
  generation: number;
  token: string;
  appIdentity: string;
}

const UNAUTHORIZED = "MCP App instance is no longer authorized";

/** The outcome word of a call's failure (the same words as the Rust runner). */
function classify(message: string): string {
  if (message.includes("cancelled")) return "cancelled";
  if (message.includes("timed out")) return "timedOut";
  if (message.includes("not running") || message.includes("not available")) return "notRunning";
  if (message.includes("closed") || message.includes("reloaded")) return "closed";
  return "error";
}

type Settled = { ok: unknown } | { failed: string };

async function runSequence(fixture: Fixture): Promise<string[]> {
  const serverName = fixture.server.name;
  const current = { identity: fixture.server.identity, generation: fixture.server.generation };
  const instances = new McpUiInstances();
  const leases = new Map<string, Lease>();
  const callIds = new Map<string, string>();
  const settles = new Map<string, Promise<Settled>>();
  const controllers = new Map<string, AbortController>();
  // Every model call published to a panel, in order (the mailbox's deliveries).
  const published: Array<{ callId: string; cancelled?: boolean }> = [];
  const exposed = new Map<string, Array<McpAppProvidedToolDefinition>>();
  const executors = new Map<string, (call: never, options: { signal: AbortSignal }) => Promise<unknown>>();
  let counter = 0;

  const registry = new McpUiAppToolRegistry({
    applyTools: (sessionId, definitions, execute) => {
      exposed.set(sessionId, [...definitions]);
      executors.set(sessionId, execute as never);
      return definitions.map((d) => d.modelName);
    },
    publishCall: (_sessionId, _target, call) => {
      published.push({ callId: call.callId, cancelled: call.cancelled });
    },
    createCallId: () => `node-call-${++counter}`,
  });

  const scopeOf = (step: Step, lease: Lease) => ({
    sessionId: step.session ?? "",
    pluginId: "p",
    serverName,
    workspace: { workspacePath: "/w" },
    instance: lease,
    scopeId: lease.token,
    generation: lease.generation,
  });
  const leaseOf = (step: Step): Lease => {
    const lease = leases.get(step.lease ?? step.as ?? "");
    if (!lease) throw new Error(`unknown lease ${step.lease}`);
    return lease;
  };
  /** The protocol's lease check (`validate`), with its binding; a refused lease is `unauthorized`. */
  const validated = (step: Step, lease: Lease): string | null => {
    try {
      instances.validate(lease as never, scopeOf(step, lease) as never, current);
      return null;
    } catch (error) {
      expect((error as Error).message).toBe(UNAUTHORIZED);
      return "unauthorized";
    }
  };

  const run = async (step: Step): Promise<string> => {
    switch (step.op) {
      case "openPanel": {
        const lease = instances.open(
          {
            workspace: "/w",
            sessionId: step.session ?? "",
            pluginId: "p",
            serverName,
            scopeId: step.scope ?? "",
            resourceUri: "ui://a",
            ownerWebContentsId: 7,
          },
          current,
        );
        leases.set(step.as ?? "", lease);
        return "opened";
      }
      case "closePanel": {
        const lease = leaseOf(step);
        const closed = instances.close(lease as never);
        if (closed) {
          // The abort listener of the panel: its tools are unregistered before the notice.
          registry.unregister(step.session ?? "", { scopeId: lease.token, generation: lease.generation });
        }
        return closed ? "closed" : "not-closed";
      }
      case "register": {
        const lease = leaseOf(step);
        const tools = (step.tools ?? []).map((name) => ({ name, inputSchema: { type: "object" as const } }));
        const answer = registry.register({
          ...scopeOf(step, lease),
          serverName,
          tools,
        } as never);
        return `registered:${answer.tools.map((t) => t.modelName).join(",")}`;
      }
      case "exposed": {
        const names = (exposed.get(step.session ?? "") ?? []).map((d) => d.modelName);
        return `exposed:${names.join(",")}`;
      }
      case "unregister": {
        const lease = leaseOf(step);
        const removed = registry.unregister(step.session ?? "", {
          scopeId: lease.token,
          generation: lease.generation,
        } as never);
        return `removed:${removed}`;
      }
      case "call": {
        const alias = step.as ?? "";
        const definition = (exposed.get(step.session ?? "") ?? []).find((d) => d.modelName === step.tool);
        const execute = executors.get(step.session ?? "");
        if (!definition || !execute) return "not-running";
        const controller = new AbortController();
        const before = published.length;
        const full = execute(
          { definition, arguments: step.arguments ?? {}, toolCallId: alias } as never,
          { signal: controller.signal },
        );
        controllers.set(alias, controller);
        settles.set(
          alias,
          full.then(
            (ok) => ({ ok }),
            (error: Error) => ({ failed: error.message }),
          ),
        );
        if (published.length === before) return "not-running";
        callIds.set(alias, published[before].callId);
        return "started";
      }
      case "claim":
      case "resolve": {
        const lease = leaseOf(step);
        const refused = validated(step, lease);
        if (refused) return refused;
        const callId = callIds.get(step.call ?? "") ?? "";
        const sessionId = step.session ?? "";
        const base = { ...scopeOf(step, lease), sessionId, callId };
        const accepted =
          step.op === "claim"
            ? registry.claim(base as never)
            : registry.resolve({ ...base, result: step.result ?? { content: [] } } as never);
        return accepted ? "accepted" : "rejected";
      }
      case "cancelCall": {
        controllers.get(step.call ?? "")?.abort();
        return "ok";
      }
      case "collectCall": {
        const settled = await settles.get(step.call ?? "");
        if (!settled) throw new Error(`no call ${step.call}`);
        return "ok" in settled ? "done" : classify(settled.failed);
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  };

  const actual: string[] = [];
  for (const step of fixture.steps) actual.push(await run(step));
  return actual;
}

describe("MCP App app-tools conformance (Node half)", () => {
  it("McpUiAppToolRegistry with McpUiInstances matches every expected outcome of the shared fixture", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    const actual = await runSequence(fixture);
    const mismatches = fixture.steps
      .map((step, index) => ({ index, want: step.expect, got: actual[index] }))
      .filter(({ want, got }) => want !== got);
    expect(mismatches).toEqual([]);
  });
});
