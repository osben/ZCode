import { describe, expect, it } from "vitest";
import {
  appendTreeChildrenCopy,
  describeTreeChildren,
  sumTreeCounts,
} from "../src/lib/taskTreeCounts.js";

// specs/session-deletion-cascade.md §2: honest, child-aware delete copy.

const intl = {
  formatPlural: ({ id }: { id: string }, count: number) => `${id}=${count}`,
  formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
    values ? `${id}(${Object.values(values).join("|")})` : id,
};

const counts = (patch: Partial<Parameters<typeof sumTreeCounts>[0][number] & object> = {}) => ({
  total: 1,
  sideChats: 0,
  subagents: 0,
  workflowSessions: 0,
  workflowRuns: 0,
  running: 0,
  ...patch,
});

describe("describeTreeChildren", () => {
  it("lists only the non-zero kinds, in a stable order", () => {
    expect(
      describeTreeChildren(intl, counts({ sideChats: 2, subagents: 0, workflowSessions: 1 })),
    ).toBe("taskList.childSideChatsCount=2, sessionManager.delete.workflowSessions=1");
  });

  it("returns null for sessions without children", () => {
    expect(describeTreeChildren(intl, counts())).toBeNull();
  });
});

describe("appendTreeChildrenCopy", () => {
  it("appends the exact list when counts are known", () => {
    expect(appendTreeChildrenCopy(intl, "body", counts({ subagents: 3 }))).toBe(
      "body\n\nsessionManager.delete.includes(taskList.childSubagentsCount=3)",
    );
  });

  it("adds nothing when the sessions have no children", () => {
    expect(appendTreeChildrenCopy(intl, "body", counts())).toBe("body");
  });

  it("falls back to the generic sentence when counts are unavailable", () => {
    expect(appendTreeChildrenCopy(intl, "body", null)).toBe(
      "body\n\nsessionManager.delete.includesGeneric",
    );
  });
});

describe("sumTreeCounts", () => {
  it("adds counts across workspaces", () => {
    expect(
      sumTreeCounts([counts({ sideChats: 1, total: 2 }), counts({ running: 1, total: 3 })]),
    ).toEqual(counts({ sideChats: 1, running: 1, total: 5 }));
  });

  it("is null as soon as one workspace could not be counted", () => {
    expect(sumTreeCounts([counts(), null])).toBeNull();
  });
});
