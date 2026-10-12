import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_ROOT_PAGE_ID,
  createCommandCenterPageStack,
  getActiveCommandCenterPage,
  popCommandCenterPage,
  pushCommandCenterPage,
  resetCommandCenterPageStack,
  type CommandCenterPageRef,
} from "@/command-center/commandCenterPageStack.js";

const THEME_MODE_PAGE: CommandCenterPageRef = {
  id: "theme-mode",
  placeholderId: "commandCenter.placeholder.themeMode",
  commandId: "theme-mode",
};

const THEME_PALETTE_PAGE: CommandCenterPageRef = {
  id: "theme-palette",
  placeholderId: "commandCenter.placeholder.themePalette",
  commandId: "theme-palette",
};

describe("createCommandCenterPageStack", () => {
  it("starts at the root with an empty stack", () => {
    const stack = createCommandCenterPageStack();
    expect(stack.pages).toEqual([]);
    expect(stack.queryByPageId).toEqual({});
    expect(getActiveCommandCenterPage(stack)).toBeNull();
  });
});

describe("pushCommandCenterPage", () => {
  it("pushes the page and clears the input for a first visit", () => {
    const transition = pushCommandCenterPage(
      createCommandCenterPageStack(),
      THEME_MODE_PAGE,
      "theme",
    );

    expect(getActiveCommandCenterPage(transition.stack)).toEqual(THEME_MODE_PAGE);
    expect(transition.query).toBe("");
    // 根查询词被记住，返回时可恢复。
    expect(transition.stack.queryByPageId[COMMAND_CENTER_ROOT_PAGE_ID]).toBe("theme");
  });

  it("restores the page's remembered query on a second visit", () => {
    let stack = createCommandCenterPageStack();
    stack = pushCommandCenterPage(stack, THEME_MODE_PAGE, "root-query").stack;
    // 在子页面输入查询词后返回根，再重新进入：应恢复该页上次的查询词。
    const popped = popCommandCenterPage(stack, "dark");

    const revisit = pushCommandCenterPage(popped.stack, THEME_MODE_PAGE, "another-root-query");
    expect(revisit.query).toBe("dark");
    // 根查询词同样更新为再次进入前的输入。
    expect(revisit.stack.queryByPageId[COMMAND_CENTER_ROOT_PAGE_ID]).toBe("another-root-query");
  });
});

describe("popCommandCenterPage", () => {
  it("returns to the previous page and restores each page's own query", () => {
    let stack = createCommandCenterPageStack();
    stack = pushCommandCenterPage(stack, THEME_MODE_PAGE, "root-query").stack;
    stack = pushCommandCenterPage(stack, THEME_PALETTE_PAGE, "mode-query").stack;

    const toThemeMode = popCommandCenterPage(stack, "ocean");
    expect(getActiveCommandCenterPage(toThemeMode.stack)).toEqual(THEME_MODE_PAGE);
    expect(toThemeMode.query).toBe("mode-query");
    // 被弹出页面的查询词仍然保留，供再次进入时恢复。
    expect(toThemeMode.stack.queryByPageId[THEME_PALETTE_PAGE.id]).toBe("ocean");

    const toRoot = popCommandCenterPage(toThemeMode.stack, "changed-mode-query");
    expect(getActiveCommandCenterPage(toRoot.stack)).toBeNull();
    expect(toRoot.query).toBe("root-query");
    expect(toRoot.stack.queryByPageId[THEME_MODE_PAGE.id]).toBe("changed-mode-query");
  });

  it("is a no-op on an empty stack", () => {
    const stack = createCommandCenterPageStack();
    const transition = popCommandCenterPage(stack, "query");
    expect(transition.stack).toBe(stack);
    expect(transition.query).toBe("query");
  });
});

describe("resetCommandCenterPageStack", () => {
  it("clears the stack, keeps per-page query memory, and restores the root query", () => {
    let stack = createCommandCenterPageStack();
    stack = pushCommandCenterPage(stack, THEME_MODE_PAGE, "theme").stack;

    const transition = resetCommandCenterPageStack(stack, "dark");
    expect(transition.stack.pages).toEqual([]);
    expect(transition.query).toBe("theme");
    expect(transition.stack.queryByPageId[THEME_MODE_PAGE.id]).toBe("dark");
  });
});
