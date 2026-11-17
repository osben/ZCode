// Fork F4b (specs/fork-rust-node-helper.md "F4b browser broker", F4-D5, F4-D7). Node's broker tests
// (bootstrap/tests/browser-control-broker.test.ts) are the oracle; these cases port the parts the helper
// owns: child registration, lifecycle release and the tab-owner routing.
import { describe, expect, it } from "vitest";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";
import { ProtocolRequestError } from "../../src/zcode-protocol/server-types.js";
import { ForkRustBrowserControl } from "../../src/fork-rust-helper/browser-control.js";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

function harness(sessions: string[] = ["parent", "child"]) {
  const sent: Sent[] = [];
  const context = {
    sessions: new Map(
      sessions.map((id) => [
        id,
        { sessionId: id, workspace: { workspacePath: "/work" }, deliveryKind: "desktop-continuous" },
      ]),
    ),
    requestClient: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === "interaction/browserList") return Promise.resolve({ browsers: [] });
      return Promise.resolve({ ok: true, result: {}, scope: undefined });
    },
    deps: {},
    logger: undefined,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, sent, control: new ForkRustBrowserControl({ context }) };
}

const executes = (sent: Sent[]) => sent.filter((call) => call.method === "interaction/browserExecute");

describe("helper child-session registration (F4-D7)", () => {
  it("a duplicate childSession with the same parent and tab owner is a no-op", () => {
    const { control } = harness();
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    expect(() =>
      control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" }),
    ).not.toThrow();
  });

  it("a childSession for an id already registered to another parent is refused as invalid params", () => {
    const { control } = harness(["parent", "other", "child"]);
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    let error: unknown;
    try {
      control.childSession({ childSessionId: "child", parentSessionId: "other", tabOwner: "parent" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect((error as ProtocolRequestError).code).toBe(-32602);
  });

  it("childSessionEnd for an unknown id is ignored, with no Host request", async () => {
    const { control, sent } = harness();
    await expect(control.childSessionEnd({ childSessionId: "nobody" })).resolves.toBeUndefined();
    expect(executes(sent)).toHaveLength(0);
  });

  it("a tab-owner child's end releases its registration only, not the parent's tab", async () => {
    const { control, sent } = harness();
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    await control.childSessionEnd({ childSessionId: "child" });
    expect(executes(sent)).toHaveLength(0);
  });

  it("a parent that closes before its child keeps the child registration until the child's end", async () => {
    const { control, sent } = harness();
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    await control.closeSession({ sessionId: "parent" });
    await control.childSessionEnd({ childSessionId: "child" });
    // The end is accepted after the parent's close; the second end is an unknown id and is ignored.
    await expect(control.childSessionEnd({ childSessionId: "child" })).resolves.toBeUndefined();
    expect(executes(sent).every((call) => call.params.sessionId === "parent" || call.params.controlScopeId === undefined)).toBe(true);
  });
});

describe("helper broker lifecycle and routing (ported from browser-control-broker.test.ts)", () => {
  it("a child's browser list is sent with the parent as the tab owner", async () => {
    const { control, sent } = harness();
    control.childSession({ childSessionId: "child", parentSessionId: "parent", tabOwner: "parent" });
    await control.port.list({ sessionId: "child", turnId: "turn-1" } as never);
    const list = sent.find((call) => call.method === "interaction/browserList");
    expect(list?.params.sessionId).toBe("parent");
  });

  it("turnEnded is sent after the session's browser connection is used", async () => {
    const { control, sent } = harness();
    await control.port.turnEnded({ sessionId: "parent", turnId: "turn-1" } as never);
    // No connection was used by this session, so the lifecycle has nothing to send to Main.
    expect(executes(sent)).toHaveLength(0);
  });
});
