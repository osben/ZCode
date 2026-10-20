// @vitest-environment jsdom

// Actor transcript pane (docs/dynamic-workflow/presentation.md "Subagent transcripts"):
// a nested read-only SessionPane, composed the same way as SubagentSessionSidePane.
//
// What is pinned here is the **composition**, not the session content: the actor session is a real persisted
// session whose liveness, cold resume, and history are all handled by the existing SessionPane pipeline. The
// only thing that must be guaranteed is "what is read is that actor's session, and it is read-only" — wire
// the sessionId wrong and the pane quietly shows someone else's conversation.
//
// The other half is the **not-started gate** ("the actor transcript's not-started state"): the actor session
// is created only when its first ask is dispatched, so opening the tab early would subscribe to a session that
// does not exist yet, leaving the projection store stuck in error waiting for a manual retry. When notStarted,
// the gate attaches no subscription and renders a placeholder instead.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";

const paneState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  /**
   * The sessionId at the time of **each render** of SessionPane (not per mount — rerenders of the same mount
   * enqueue repeatedly).
   * An empty array is therefore the strong, assertable proposition; for identity checks look at the deduped
   * set, and never write rerender counts into expectations.
   */
  rendered: [] as string[],
}));

// The layer must be a **stable reference**: the gate acquires the parent session lease synchronously during
// render (with the layer as a useMemo dependency), so a fresh object per render would create a new lease every
// frame. In production useV4Conversation returns a useMemo'd bundle, which is stable by construction.
const leaseState = vi.hoisted(() => ({
  /** The sequence of sessionIds subscribed via the layer — this is the gate's assertion surface. */
  acquired: [] as string[],
  release: vi.fn(),
}));
const conversation = vi.hoisted(() => ({
  layer: {
    acquire: (sessionId: string) => {
      leaseState.acquired.push(sessionId);
      return { release: leaseState.release };
    },
  },
}));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      paneState.rendered.push(String(props.sessionId));
      // Replicates the real SessionPane's subscription seam (`SessionPane.tsx:1617-1633`: the mount effect calls
      // `layer.acquire(effectiveSessionId)`, and acquire connects immediately). The stub must actually walk this
      // path, otherwise "never subscribed to the actor session" degenerates into an empty assertion — the stub
      // subscribes to nothing to begin with.
      React.useEffect(() => {
        const lease = conversation.layer.acquire(String(props.sessionId));
        return () => lease.release();
      }, [props.sessionId]);
      return React.createElement("div", { "data-testid": "mock-session-pane" });
    },
  };
});

const scopeState = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children, scope }: { children?: ReactNode; scope: unknown }) => {
      scopeState.scope = scope;
      return React.createElement(React.Fragment, null, children);
    },
    useV4Conversation: () => conversation,
  };
});

const projectionState = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock("@/v4/useConversationProjection.js", () => ({
  // Replicates production semantics: **a null lease has no snapshot** (`CLOSED_STATE`). This must not be
  // cut short, otherwise the gate appears to have a projection on the first frame while production does not —
  // SessionPane would mount once, the subscription would fail, and the failed store would live out its 30s in
  // SessionDataLayer's keep-warm with status:"error"; the acquire at gate release would reuse it as-is
  // (refCount++ without reconnecting) and the dead pane would persist.
  useConversationProjection: (lease: unknown) =>
    lease === null || lease === undefined
      ? { snapshot: undefined }
      : { snapshot: projectionState.snapshot },
}));

// eslint-disable-next-line import/first -- The component under test must be imported after the mocks.
import { cleanup, render } from "@testing-library/react";
// eslint-disable-next-line import/first
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
// eslint-disable-next-line import/first
import { openWorkflowActorSessionSidePane } from "@/lib/workspaceSidePane.js";

const ACTOR_SESSION_ID = "dwf-dwfrun-1-actor_1@2";

function tabOf(overrides: Partial<WorkflowActorSessionSidePaneTab> = {}) {
  const state = openWorkflowActorSessionSidePane(null, {
    workspaceKey: "ssh://host/workspace",
    workspacePath: "/workspace",
    workspaceIdentity: "ssh://host/workspace",
    remoteSessionId: "remote-1",
    parentSessionId: "parent-a",
    runId: "dwfrun-1",
    actorSessionId: ACTOR_SESSION_ID,
    siteId: "actor#1",
    ordinal: 2,
    actorName: "reviewer",
  });
  const tab = state.tabs[0] as WorkflowActorSessionSidePaneTab;
  return { ...tab, ...overrides };
}

/**
 * The run projection for this actor. `nodes` decides the gate's verdict; the gate looks the actor up by slot
 * (runId, siteId, ordinal), and `actors` can be swapped wholesale (`[]` = the slot has not appeared yet).
 */
function snapshotWith(
  nodes: WorkflowRunState["nodes"],
  sessionId = ACTOR_SESSION_ID,
  actors: WorkflowRunState["actors"] = [
    { siteId: "actor#1", ordinal: 2, name: "reviewer", sessionId, status: "waiting" },
  ],
) {
  return {
    rows: { window: [] },
    workflowRuns: {
      revision: 1,
      runs: [
        {
          runId: "dwfrun-1",
          status: "running" as const,
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors,
          nodes,
          lastEventSequence: 1,
        },
      ],
    },
  };
}

function renderTab(tab: WorkflowActorSessionSidePaneTab, locale: "en-US" | "zh-CN" = "en-US") {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(WorkflowActorSessionSidePane, { tab, focused: true }),
  );
}

function renderPane(locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
    ),
  );
}

describe("WorkflowActorSessionSidePane", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
    paneState.rendered = [];
    scopeState.scope = null;
    projectionState.snapshot = null;
    leaseState.acquired = [];
    leaseState.release.mockClear();
  });

  it("把 actor 会话喂给一个只读的嵌套 SessionPane", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
    );

    expect(paneState.props).toMatchObject({
      allowWorkspaceFileRewind: true,
      focused: true,
      paneId: tabOf().id,
      readOnly: true,
      // The key line: what is read is the actor session, not the parent session, and not the run id.
      sessionId: "dwf-dwfrun-1-actor_1@2",
      telemetryVisible: true,
      workspacePath: "/workspace",
    });
  });

  it("不下发 subagent 下钻回调：actor 的工具面里没有 subagent", () => {
    // The engine spec's "Actor tool surface" turns subagent off, so there is no nested drill-down to click and
    // the pane must not pretend there is an entry point.
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(paneState.props?.onOpenSubagentSession).toBeUndefined();
    // Same for rootSessionId: the actor session is in no subagent tree, and inventing a root would make the
    // read-only pane subscribe to a session unrelated to it.
    expect(paneState.props?.rootSessionId).toBeUndefined();
  });

  it("workspace scope 从 tab 上原样传给 pane provider（远程同路径工作区不串台）", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(scopeState.scope).toEqual({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-1",
    });
  });

  it("非 focused 时不上报前台 telemetry", () => {
    renderToStaticMarkup(
      createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: false }),
    );

    expect(paneState.props).toMatchObject({ focused: false, telemetryVisible: false });
  });
});

describe("WorkflowActorSessionSidePane 未启动门", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
    paneState.rendered = [];
    scopeState.scope = null;
    projectionState.snapshot = null;
    leaseState.acquired = [];
    leaseState.release.mockClear();
  });

  it("actor 尚未派发任何节点时渲染占位，且**不挂订阅**", () => {
    // This is the very bug: the session is created only when the first ask is dispatched, so an early
    // subscription is a guaranteed sessionNotFound, and the failed projection store then just waits for a
    // manual retry. The gate keeps SessionPane from mounting here.
    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "queued", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    const view = renderPane();

    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    // The **negation** the gate must guarantee, and the first thing that should speak: acquire never received
    // the actor session id.
    // Written as a negation rather than `toEqual(["parent-a"])` so that when a legitimate acquire is added in
    // the future, this assertion still says only what it is supposed to say.
    expect(leaseState.acquired).not.toContain(ACTOR_SESSION_ID);
    // At the same time confirm the gate **really** read the projection: the parent session was subscribed. Otherwise the negation above could pass by doing nothing at all.
    expect(leaseState.acquired).toContain("parent-a");
    // Not a single frame was ever rendered. One rendered frame means one subscription, and the failed store
    // would live out its 30s in keep-warm and be reused as-is by later acquires — by then even a gate release
    // could not buy back a live pane.
    expect(paneState.rendered).toEqual([]);
    expect(view.queryByTestId("mock-session-pane")).toBeNull();
    expect(paneState.props).toBeNull();
  });

  it("占位文案双语可读", () => {
    projectionState.snapshot = snapshotWith([]);

    const en = renderPane("en-US");
    expect(en.getByTestId("workflow-actor-not-started").textContent).toContain("Not started yet");
    cleanup();

    const zh = renderPane("zh-CN");
    expect(zh.getByTestId("workflow-actor-not-started").textContent).toContain("尚未启动");
  });

  it("投影抬升到 dispatched 后自动换成嵌套 SessionPane（自愈，无需 retry）", () => {
    projectionState.snapshot = snapshotWith([]);
    const view = renderPane();
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();

    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "dispatched", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowActorSessionSidePane, { tab: tabOf(), focused: true }),
      ),
    );

    expect(view.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(view.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(paneState.props).toMatchObject({ sessionId: ACTOR_SESSION_ID, readOnly: true });
    // Positive evidence of self-healing: after the gate releases, the subscription **really** happens (before first dispatch it never happened once).
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("started 与 unknown 都照旧订阅：投影里查不到这个 actor 时绝不拦", () => {
    // After the run is evicted by the 8-run cap or on cold resume the projection is empty; subscribing directly
    // is the transcript's only path — blocking unknown would shut the only persisted view of a finished run.
    // The tab carries a session id, so subscribe to it.
    projectionState.snapshot = snapshotWith([], ACTOR_SESSION_ID, []);
    const unknown = renderPane();
    expect(unknown.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(unknown.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
    cleanup();
    leaseState.acquired = [];

    // The projection being absent entirely (parent session not connected yet / cold start) is unknown too.
    projectionState.snapshot = null;
    const empty = renderPane();
    expect(empty.queryByTestId("mock-session-pane")).not.toBeNull();
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("未启动药丸开的槽位 tab（没有会话 id）：占位、不订阅；actor 带着会话出现并派发后自愈", () => {
    // docs/dynamic-workflow/presentation.md "The pill": a tab can be opened before the actor appears.
    const { actorSessionId: _absent, ...slotTab } = tabOf();
    projectionState.snapshot = snapshotWith([], ACTOR_SESSION_ID, []);
    const view = render(renderTab(slotTab));
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    expect(leaseState.acquired).toContain("parent-a");
    expect(leaseState.acquired).not.toContain(ACTOR_SESSION_ID);
    expect(paneState.rendered).toEqual([]);

    // The actor has appeared but not dispatched: still the placeholder (the session id is known, but
    // subscribing to it is a guaranteed sessionNotFound).
    // The pane is memoized and the stub projection will not trigger a rerender on its own, so each time an
    // equivalent but new tab object is passed.
    projectionState.snapshot = snapshotWith([]);
    view.rerender(renderTab({ ...slotTab }));
    expect(view.queryByTestId("workflow-actor-not-started")).not.toBeNull();
    expect(paneState.rendered).toEqual([]);

    // First node dispatched: the session id comes from the projection and SessionPane mounts — the tab itself never received a session id.
    projectionState.snapshot = snapshotWith([
      { siteId: "ask#1", ordinal: 1, phase: "dispatched", actorSiteId: "actor#1", actorOrdinal: 2 },
    ]);
    view.rerender(renderTab({ ...slotTab }));
    expect(view.queryByTestId("workflow-actor-not-started")).toBeNull();
    expect(paneState.props).toMatchObject({ sessionId: ACTOR_SESSION_ID, readOnly: true });
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });

  it("started 时订阅的是 actor 会话本身，不是父会话的替身", () => {
    // The gate is a layer added **before** SessionPane, and the easiest miswiring is passing the parent session id down.
    projectionState.snapshot = snapshotWith([
      {
        siteId: "ask#1",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 2,
      },
    ]);
    renderPane();

    // Look at the deduped set rather than the sequence: the rerender count is not the contract; "only ever saw this one session id" is.
    expect(new Set(paneState.rendered)).toEqual(new Set([ACTOR_SESSION_ID]));
    expect(leaseState.acquired).toContain(ACTOR_SESSION_ID);
  });
});
